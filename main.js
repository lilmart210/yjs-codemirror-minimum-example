const express = require('express');
const cors = require('cors');
const ws = require('ws');
const yjs = require('yjs')


const PORT = 5264;

/**@type {express} */
const app = express();
const wss = new ws.WebSocketServer({ noServer: true });

app.use(cors({
    allowedHeaders: '*',
    methods: '*',
    origin: '*'
}))

const document = new yjs.Doc();
const ydoc = document.getText('y-document');
ydoc.insert(0, "This is the Starting Document Fellas")


wss.on('connection', (sock, msg) => {
    //for some reason readystate is aleady past the open stage
    console.log("Socket connected", sock.readyState);

    sock.on('message', (data, isbin) => {
        const parsed = isbin ? JSON.parse(data.toString()) : JSON.parse(data);

        console.log("received");

        if (parsed.msg == 'Get Document') {
            //send the current document.
            const currentDocState = yjs.encodeStateAsUpdateV2(document);
            const bsix = Buffer.from(currentDocState).toString('base64');
            
            console.log(currentDocState);

            sock.send(JSON.stringify({
                msg: 'Get Document',
                document: bsix
            }))
        } else if (parsed.msg == 'Update') {
            //apply this update 
            const update = Buffer.from(parsed.update,'base64');
            
            yjs.applyUpdateV2(document,update);
            //broad cast to the other documents
            for(const alistener of wss.clients){
                if(alistener == sock) continue;
                console.log("sent to others");
                alistener.send(JSON.stringify(parsed));
            }
        } else if(parsed.msg == 'Awareness'){
            for(const alistener of wss.clients){
                if(alistener == sock) continue;
                alistener.send(JSON.stringify(parsed));
            }
        }
    })

    sock.on('close', () => console.log("socket closed"))
})


async function main() {
    const aserver = app.listen(PORT);

    aserver.on('upgrade', (req, sock, head) => {
        wss.handleUpgrade(req, sock, head, (aws) => {
            wss.emit('connection', aws, req);
        })
    });

}

main();