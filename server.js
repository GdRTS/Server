"use strict";
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
var dgram = __importStar(require("dgram"));
// DATA
var connections = {};
var playerByAddress = {}; // 'address:port'
var steps = {};
var expectAcknowledgement = {};
var resendThreshold = 500; // how long to wait until packet is resent
var localSeq = 0;
// SERVER
var server = dgram.createSocket('udp4');
var port = 4242;
// PACKET HANDLERS
function receiveConnectionPacket(packet, address, port) {
    var player = findFreePlayerId();
    if (!playerByAddress[address + ":" + port]) {
        connections[player] = { player: player, address: address, port: port };
        playerByAddress[address + ":" + port] = player;
    }
    else {
        player = playerByAddress[address + ":" + port];
    }
    sendConnectionAcknowledgement(player, packet.seq);
    sendPlayerJoined(player);
}
function receiveDataPacket(packet, player) {
    var data = {};
    data[player] = packet.data;
    var step = steps[packet.step];
    if (step) {
        step.received++;
        step.data[player] = data;
    }
    else {
        steps[packet.step] = {
            received: 1,
            data: data
        };
    }
    sendBroadcast(player, packet.data, packet.seq, packet.step);
}
function receiveAcknowledgementPacket(packet, player) {
    delete expectAcknowledgement[packet.ack];
    if (packet.seq) {
        sendAcknowledgement(player, packet.seq);
    }
}
function receiveGameStartedPacket(packet) {
    sendGameStartedBroadcast(packet.seq);
}
// SENDERS
function sendAcknowledgement(player, seq) {
    var packet = {
        flag: 'ack',
        ack: seq
    };
    var destination = connections[player];
    server.send(JSON.stringify(packet), destination.port, destination.address);
}
function sendGameStartedBroadcast(seq) {
    var packet = {
        flag: 'start',
        ack: seq,
        seq: localSeq
    };
    Object.values(connections).forEach(function (connection) {
        packet.seq = localSeq;
        server.send(JSON.stringify(packet), connection.port, connection.address);
        expectAcknowledgement[localSeq] = { packet: packet, player: connection.player, ttl: resendThreshold };
        localSeq++;
    });
}
function sendPlayerJoined(player) {
    var packet = {
        flag: 'join',
        seq: localSeq,
        players: Object.keys(connections).length,
        player: player
    };
    Object.values(connections).filter(function (connection) { return connection.player !== player; }).forEach(function (connection) {
        packet.seq = localSeq;
        server.send(JSON.stringify(packet), connection.port, connection.address);
        expectAcknowledgement[localSeq] = { packet: packet, player: connection.player, ttl: resendThreshold };
        localSeq++;
    });
}
function sendConnectionAcknowledgement(player, seq) {
    var packet = {
        flag: 'cack',
        ack: seq,
        players: Object.keys(connections).length,
        player: player
    };
    var destination = connections[player];
    server.send(JSON.stringify(packet), destination.port, destination.address);
}
function sendBroadcast(player, data, seq, step) {
    var packet = {
        flag: 'broadcast',
        seq: localSeq,
        ack: seq,
        player: player,
        data: data,
        step: step
    };
    // TODO: fix sending the same ack to every player rather than just the one we are responding to
    // Same issue exists on other senders
    Object.values(connections).forEach(function (connection) {
        packet.seq = localSeq;
        server.send(JSON.stringify(packet), connection.port, connection.address);
        expectAcknowledgement[localSeq] = { packet: packet, player: connection.player, ttl: resendThreshold };
        localSeq++;
    });
}
function resendPacket(packet, player) {
    var connection = connections[player];
    server.send(JSON.stringify(packet), connection.port, connection.address);
}
// LISTENERS
server.on('listening', function () {
    console.log("server listening on port " + port);
});
server.on('error', function (err) {
    console.log("server error:\n" + err.stack);
    server.close();
});
server.on('message', function (data, rinfo) {
    var packet = JSON.parse(data);
    var sender = playerByAddress[rinfo.address + ":" + rinfo.port];
    switch (packet.flag) {
        case 'connect':
            receiveConnectionPacket(packet, rinfo.address, rinfo.port);
            break;
        case 'disconnect':
            break;
        case 'start':
            receiveGameStartedPacket(packet);
            break;
        case 'data':
            receiveDataPacket(packet, sender);
            break;
        case 'ack':
            receiveAcknowledgementPacket(packet, sender);
            break;
    }
    console.log("server got: " + JSON.stringify(packet) + " from " + rinfo.address + ":" + rinfo.port);
});
// RESEND
setInterval(function () {
    Object.values(expectAcknowledgement).forEach(function (req) {
        if (req.ttl <= 0) {
            resendPacket(req.packet, req.player);
            req.ttl = resendThreshold;
        }
        else {
            req.ttl -= 25;
        }
    });
}, 25);
// INITIALIZE
server.bind(port);
//
function findFreePlayerId() {
    var i = 0;
    while (true) {
        if (!connections[i]) {
            return i;
        }
        i++;
    }
}
