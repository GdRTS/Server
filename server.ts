import * as dgram from 'dgram'

// MODEL

type Flag = 'connect' | 'disconnect' | 'data' | 'broadcast' | 'ack' | 'cack' | 'join' | 'start'

interface Packet {
    flag: Flag
}

interface ConnectionPacket extends Packet {
    flag: 'connect'
    seq: number
}

interface ConnectionAcknowledgementPacket extends Packet {
    flag: 'cack'
    player: number
    players: number
    ack: number
    seq?: number
}

interface PlayerJoinedPacket extends Packet {
    flag: 'join'
    player: number
    players: number
    seq: number
}

interface GameStartedPacket extends Packet {
    flag: 'start'
    seq: number
}

interface GameStartedBroadcastPacket extends Packet {
    flag: 'start'
    seq: number
    ack: number
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
    let player = findFreePlayerId()
    if (!playerByAddress[`${address}:${port}`]) {
        connections[player] = {player: player, address, port}
        playerByAddress[`${address}:${port}`] = player
    } else {
        player = playerByAddress[`${address}:${port}`]
    }
    sendConnectionAcknowledgement(player, packet.seq)
    sendPlayerJoined(player)
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

function receiveGameStartedPacket(packet: GameStartedPacket) {
    sendGameStartedBroadcast(packet.seq)
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

function sendGameStartedBroadcast(seq: number) {
    const packet: GameStartedBroadcastPacket = {
        flag: 'start',
        ack: seq,
        seq: localSeq
    }
    Object.values(connections).forEach((connection) => {
        packet.seq = localSeq
        server.send(JSON.stringify(packet), connection.port, connection.address)
        expectAcknowledgement[localSeq] = {packet, player: connection.player, ttl: resendThreshold}
        localSeq++
    })
}

function sendPlayerJoined(player) {
    const packet: PlayerJoinedPacket = {
        flag: 'join',
        seq: localSeq,
        players: Object.keys(connections).length,
        player
    }
    Object.values(connections).filter((connection) => connection.player !== player).forEach((connection) => {
        packet.seq = localSeq
        server.send(JSON.stringify(packet), connection.port, connection.address)
        expectAcknowledgement[localSeq] = {packet, player: connection.player, ttl: resendThreshold}
        localSeq++
    })
}

function sendConnectionAcknowledgement(player: number, seq: number) {
    const packet: ConnectionAcknowledgementPacket = {
        flag: 'cack',
        ack: seq,
        players: Object.keys(connections).length,
        player
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
    // TODO: fix sending the same ack to every player rather than just the one we are responding to
    // Same issue exists on other senders
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
            break
        case 'disconnect':
            break
        case 'start':
            receiveGameStartedPacket(<GameStartedPacket>packet)
            break
        case 'data':
            receiveDataPacket(<DataPacket>packet, sender)
            break
        case 'ack':
            receiveAcknowledgementPacket(<AcknowledgementPacket>packet, sender)
            break
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

//

function findFreePlayerId() {
    let i = 0
    while (true) {
        if (!connections[i]) {
            return i
        }
        i++
    }
}