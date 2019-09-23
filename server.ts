import * as dgram from 'dgram'

// MODEL

type Flag = 'connect' | 'disconnect' | 'data' | 'broadcast' | 'ack'

interface Packet {
    flag: Flag
}

interface ConnectionPacket extends Packet {
    flag: 'connect'
    player: number
    seq: number
}

interface DataPacket extends Packet {
    flag: 'data'
    data: any
    step: number
    seq: number
}

interface BroadcastPacket extends Packet {
    flag: 'broadcast'
    step: number
    data: any
    player: number
    seq: number
    ack: number
}

interface AcknowledgementPacket extends Packet {
    flag: 'ack'
    ack: number
    seq?: number
}

interface Connection {
    address: string
    port: number
    player: number
}

interface Step {
    received: number
    data: {
        [player: number]: any
    }
}

interface RequiresAcknowledgement {
    packet: Packet
    player: number
    ttl: number
}

// DATA

const connections: {[player: number]: Connection} = {}
const playerByAddress: {[address: string]: number} = {} // 'address:port'
const steps: {[step: number]: Step} = {}
const expectAcknowledgement: {[seq: number]: RequiresAcknowledgement} = {}

let resendThreshold = 500 // how long to wait until packet is resent
let localSeq = 0

// SERVER

const server = dgram.createSocket('udp4');
const port = 4242

// PACKET HANDLERS

function receiveConnectionPacket(packet: ConnectionPacket, address: string, port: number) {
    if (!connections[packet.player]) {
        connections[packet.player] = {player: packet.player, address, port}
        playerByAddress[`${address}:${port}`] = packet.player
    }
    sendAcknowledgement(packet.player, packet.seq)
}

function receiveDataPacket(packet: DataPacket, player: number) {
    const data = {}
    data[player] = packet.data
    const step = steps[packet.step]
    if (step) {
        step.received++
        step.data[player] = data
    } else {
        steps[packet.step] = {
            received: 1,
            data
        }
    }
    sendBroadcast(player, packet.data, packet.seq, packet.step)
}

function receiveAcknowledgementPacket(packet: AcknowledgementPacket, player: number) {
    delete expectAcknowledgement[packet.ack]
    if (packet.seq) {
        sendAcknowledgement(player, packet.seq)
    }
}

// SENDERS

function sendAcknowledgement(player: number, seq: number) {
    const packet: AcknowledgementPacket = {
        flag: 'ack',
        ack: seq
    }
    const destination: Connection = connections[player]
    server.send(JSON.stringify(packet), destination.port, destination.address)
}

function sendBroadcast(player: number, data: any, seq: number, step: number) {
    const packet: BroadcastPacket = {
        flag: 'broadcast',
        seq: localSeq,
        ack: seq,
        player,
        data,
        step
    }
    Object.values(connections).forEach((connection) => {
        packet.seq = localSeq
        server.send(JSON.stringify(packet), connection.port, connection.address)
        expectAcknowledgement[localSeq] = {packet, player: connection.player, ttl: resendThreshold}
        localSeq++
    })
}

function resendPacket(packet: Packet, player: number) {
    const connection = connections[player]
    server.send(JSON.stringify(packet), connection.port, connection.address)
}

// LISTENERS

server.on('listening', () => {
  console.log(`server listening on port ${port}`);
});

server.on('error', (err) => {
  console.log(`server error:\n${err.stack}`);
  server.close();
});

server.on('message', (data: string, rinfo) => {
    const packet: Packet = JSON.parse(data)
    const sender = playerByAddress[`${rinfo.address}:${rinfo.port}`]
    switch (packet.flag) {
        case 'connect':
            receiveConnectionPacket(<ConnectionPacket>packet, rinfo.address, rinfo.port)
        case 'disconnect':
            break
        case 'data':
            receiveDataPacket(<DataPacket>packet, sender)
        case 'ack':
            receiveAcknowledgementPacket(<AcknowledgementPacket>packet, sender)
    }
    console.log(`server got: ${JSON.stringify(packet)} from ${rinfo.address}:${rinfo.port}`);
});

// RESEND

setInterval(() => {
    Object.values(expectAcknowledgement).forEach((req) => {
        if (req.ttl <= 0) {
            resendPacket(req.packet, req.player)
            req.ttl = resendThreshold
        } else {
            req.ttl -= 25
        }
    })
}, 25)

// INITIALIZE

server.bind(port);