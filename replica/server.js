const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');


const app = express();
app.use(bodyParser.json());
app.use(cors());

const replicaName = process.env.REPLICA_NAME || 'replica-unknown';

const port = parseInt(process.env.PORT || '4001');

let posts = [];

const otherReplicas = {
    replica1: 'http://replica1:4001',
    replica2: 'http://replica2:4002',
    replica3: 'http://replica3:4003'
};

// Utility: obtener lista de URIs de réplicas distintas a esta
function getPeers() {
    return Object.values(otherReplicas).filter(url => !url.includes(replicaName));
}


// Guardar post simple con timestamp y id
function addPost(author, content) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const post = { id, author, content, timestamp: new Date().toISOString(), replica: replicaName };
    posts.push(post);
    return post;
}


// GET /posts -> devuelve posts locales
app.get('/posts', (req, res) => {
    res.json({ replica: replicaName, posts });
});


// GET /debug/replicas -> info de réplicas
app.get('/debug/replicas', (req, res) => {
    res.json({ replica: replicaName, port });
});


// POST /post -> crea un post solo en esta réplica
app.post('/post', (req, res) => {
    const { author, content } = req.body || {};
    if (!author || !content) {
        return res.status(400).json({ error: 'author and content required' });
    }
    const post = addPost(author, content);
    return res.json({ message: `Saved on ${replicaName}`, post });
});


// POST /sync -> intenta obtener posts de peers y hacer merge simple
// Opcional: recibir { mode: 'pull' | 'push' } — para la demo solo pull
app.post('/sync', async (req, res) => {
    const peers = getPeers();
    let merged = 0;
    for (const peer of peers) {
        try {
            const r = await axios.get(`${peer}/posts`, { timeout: 2000 });
            const remotePosts = r.data.posts || [];
            for (const p of remotePosts) {
                if (!posts.find(x => x.id === p.id)) {
                    posts.push({ ...p });
                    merged++;
                }
            }
        } catch (err) {
            // ignore peer unreachable
        }
    }
    res.json({ message: `Merged ${merged} posts into ${replicaName}`, postsCount: posts.length });
});


app.post('/clear', (req, res) => {
    posts = [];
    res.json({ message: `Cleared posts on ${replicaName}` });
});


app.listen(port, () => {
    console.log(`${replicaName} listening on ${port}`);
});