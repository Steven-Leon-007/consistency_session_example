const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const session = require('express-session');
const path = require('path');

const app = express();

// Configurar EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors({
  origin: true,
  credentials: true
}));

// Configuración de sesiones
app.use(session({
  secret: 'session-consistency-secret',
  resave: true,
  saveUninitialized: false,
  cookie: { 
    secure: false,
    maxAge: 24 * 60 * 60 * 1000, // 24 horas
    httpOnly: true
  },
  name: 'session-id' // Nombre específico para la cookie
}));

const replicaName = process.env.REPLICA_NAME || 'replica-unknown';
const port = parseInt(process.env.PORT || '4001');

// "Base de datos" en memoria (para demo)
let posts = [];
let lastSync = {}; // Para trackear última sincronización por sesión
let clearCommands = []; // Registro de comandos de limpieza con timestamp

const otherReplicas = {
  replica1: 'http://replica1:4001',
  replica2: 'http://replica2:4002', 
  replica3: 'http://replica3:4003'
};

function getPeers() {
  return Object.values(otherReplicas).filter(url => !url.includes(replicaName));
}

// Middleware para inicializar sesión de réplica
app.use((req, res, next) => {
  if (!req.session.replicaId) {
    req.session.replicaId = replicaName;
    req.session.userId = req.session.id;
    lastSync[req.session.id] = Date.now();
  }
  next();
});

// Ruta principal - Renderiza la vista
app.get('/', async (req, res) => {
  try {
    res.render('index', {
      replica: replicaName,
      sessionId: req.session.id,
      posts: posts.filter(post => 
        post.replica === replicaName || 
        (lastSync[req.session.id] && new Date(post.timestamp).getTime() <= lastSync[req.session.id])
      )
    });
  } catch (error) {
    console.error('Error rendering view:', error);
    res.status(500).send('Error loading page');
  }
});

function addPost(author, content, sessionId) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const post = { 
    id, 
    author, 
    content, 
    timestamp: new Date().toISOString(), 
    replica: replicaName,
    sessionId: sessionId // Para tracking
  };
  posts.push(post);
  return post;
}

// GET /posts - Devuelve posts locales + sincroniza si es necesario
app.get('/posts', async (req, res) => {
  const shouldSync = req.query.sync === 'true';
  
  if (shouldSync) {
    await syncWithPeers(req.session.id);
  }
  
  // En consistencia débil por sesión, solo mostramos:
  // 1. Posts creados en esta réplica
  // 2. Posts que fueron sincronizados después de la última sincronización de la sesión
  const visiblePosts = posts.filter(post => {
    const postTimestamp = new Date(post.timestamp).getTime();
    return post.replica === replicaName || 
           (lastSync[req.session.id] && postTimestamp <= lastSync[req.session.id]);
  });
  
  res.json({ 
    replica: replicaName, 
    sessionId: req.session.id,
    lastSync: lastSync[req.session.id],
    posts: visiblePosts 
  });
});

// POST /post - Crear post (sin propagación automática)
app.post('/post', async (req, res) => {
  const { author, content } = req.body || {};
  if (!author || !content) {
    return res.status(400).json({ error: 'author and content required' });
  }
  
  const post = addPost(author, content, req.session.id);
  
  // Ya no propagamos automáticamente para demostrar consistencia débil por sesión
  
  res.json({ 
    message: `Post created on ${replicaName}`, 
    post,
    sessionId: req.session.id 
  });
});

// Sincronización manual - sincroniza todas las réplicas
app.post('/sync', async (req, res) => {
  // Primero sincronizamos comandos de limpieza de otras réplicas
  await syncClearCommands();
  
  // Luego obtenemos posts de otras réplicas
  const mergedCount = await syncWithPeers(req.session.id);
  
  // Luego propagamos todos nuestros posts a las demás réplicas
  const peers = getPeers();
  for (const peer of peers) {
    try {
      // Enviamos todos nuestros posts a cada réplica
      const localPosts = posts.filter(post => post.replica === replicaName);
      for (const post of localPosts) {
        await axios.post(`${peer}/internal/post`, post, { timeout: 2000 })
          .catch(err => console.log(`Failed to propagate post ${post.id} to ${peer}`));
      }
      
      // Enviamos nuestros comandos de limpieza
      for (const clearCmd of clearCommands) {
        await axios.post(`${peer}/internal/clear`, clearCmd, { timeout: 2000 })
          .catch(err => console.log(`Failed to propagate clear command to ${peer}`));
      }
    } catch (err) {
      console.log(`Sync failed with ${peer}`);
    }
  }

  res.json({ 
    message: `Full synchronization completed on ${replicaName}`,
    sessionId: req.session.id,
    mergedPosts: mergedCount,
    propagatedPosts: posts.filter(post => post.replica === replicaName).length,
    clearCommandsSynced: clearCommands.length
  });
});

// Información de debug
app.get('/debug/session', (req, res) => {
  res.json({
    replica: replicaName,
    sessionId: req.session.id,
    replicaId: req.session.replicaId,
    lastSync: lastSync[req.session.id],
    totalPosts: posts.length
  });
});

// Función de sincronización
async function syncWithPeers(sessionId) {
  const peers = getPeers();
  let merged = 0;
  const currentTime = Date.now();
  
  for (const peer of peers) {
    try {
      // Solo obtenemos posts desde la última sincronización de la sesión
      const response = await axios.get(`${peer}/internal/posts`, { 
        timeout: 2000,
        params: { since: lastSync[sessionId] || 0 }
      });
      
      const remotePosts = response.data.posts || [];
      for (const post of remotePosts) {
        // Solo agregamos posts que no tengamos y que sean anteriores al momento de sincronización
        if (!posts.find(p => p.id === post.id) && 
            new Date(post.timestamp).getTime() <= currentTime) {
          posts.push(post);
          merged++;
        }
      }
    } catch (err) {
      console.log(`Cannot sync with ${peer}`);
    }
  }
  
  // Actualizamos el timestamp de última sincronización para esta sesión
  lastSync[sessionId] = currentTime;
  return merged;
}

// Función para sincronizar comandos de limpieza
async function syncClearCommands() {
  const peers = getPeers();
  
  for (const peer of peers) {
    try {
      const response = await axios.get(`${peer}/internal/clear-commands`, { 
        timeout: 2000
      });
      
      const remoteClearCommands = response.data.clearCommands || [];
      for (const clearCmd of remoteClearCommands) {
        // Si no tenemos este comando de limpieza, lo aplicamos
        if (!clearCommands.find(c => c.id === clearCmd.id)) {
          applyClearCommand(clearCmd);
        }
      }
    } catch (err) {
      console.log(`Cannot sync clear commands with ${peer}`);
    }
  }
}

// Aplicar un comando de limpieza
function applyClearCommand(clearCmd) {
  // Agregamos el comando a nuestra lista
  clearCommands.push(clearCmd);
  
  // Limpiamos los posts según el comando
  const clearTime = new Date(clearCmd.timestamp).getTime();
  posts = posts.filter(post => {
    const postTime = new Date(post.timestamp).getTime();
    return postTime > clearTime; // Solo mantenemos posts posteriores al clear
  });
  
  console.log(`Applied clear command from ${clearCmd.replica} at ${clearCmd.timestamp}`);
}

// Endpoint interno para sincronización
app.get('/internal/posts', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const filteredPosts = posts.filter(post => 
    new Date(post.timestamp).getTime() > since
  );
  res.json({ posts: filteredPosts });
});

// Endpoint interno para obtener comandos de limpieza
app.get('/internal/clear-commands', (req, res) => {
  res.json({ clearCommands });
});

// Endpoint interno para recibir comandos de limpieza
app.post('/internal/clear', (req, res) => {
  const clearCmd = req.body;
  if (!clearCommands.find(c => c.id === clearCmd.id)) {
    applyClearCommand(clearCmd);
  }
  res.json({ message: 'Clear command received' });
});

// Propagación asíncrona de posts
async function propagatePost(post) {
  const peers = getPeers();
  const propagationPromises = peers.map(peer => 
    axios.post(`${peer}/internal/post`, post, { timeout: 1000 })
      .catch(err => console.log(`Propagation failed to ${peer}`))
  );
  
  await Promise.all(propagationPromises);
}

// Endpoint interno para recibir posts propagados
app.post('/internal/post', (req, res) => {
  const post = req.body;
  if (!posts.find(p => p.id === post.id)) {
    posts.push(post);
  }
  res.json({ message: 'Post received' });
});

app.post('/clear', (req, res) => {
  // Crear un comando de limpieza
  const clearCmd = {
    id: `clear-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    replica: replicaName
  };
  
  // Aplicar localmente
  applyClearCommand(clearCmd);
  
  res.json({ 
    message: `Cleared posts on ${replicaName}. Use Sync to propagate to other replicas.`,
    clearCommand: clearCmd
  });
});

app.listen(port, () => {
  console.log(`${replicaName} listening on ${port}`);
});