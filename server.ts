process.title = 'signaling-server';

// import * as fs from 'fs';
import * as https from 'https';
import http from 'http';
import express from 'express';
import { Room } from './lib/Room';
import { Peer } from './lib/Peer';
import * as socketio from 'socket.io';
// import yargs from 'yargs';
import { connectLogger, getLogger, configure } from 'log4js';
configure('./log4js.json');
const logger = getLogger('Server');

const helmet = require('helmet');
const cors = require('cors');
const bodyParser = require('body-parser');
const compression = require('compression');

// yargs.usage('Usage: $0 --cert [file] --key [file]')
// .version('signaling-server 1.0')
// .demandOption(['cert', 'key'])
// .option('cert', {describe : 'ssl certificate file'})
// .option('key', {describe: 'ssl certificate key file'});

// const certfile = yargs.argv.cert as string;
// const keyfile = yargs.argv.key as string;

// [certfile, keyfile].forEach(file => {
// 	if (!fs.existsSync(file)){
// 		logger.error('%s do not exist!', file);
// 		process.exit(-1);
// 	}
// });

// const tls = {
// 	cert: fs.readFileSync(certfile),
// 	key: fs.readFileSync(keyfile),
// };

const app = express();
app.use(compression());

app.use(connectLogger(getLogger('http'), {level: 'auto'}));

app.use(helmet.hsts());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());

const rooms = new Map<string, Room>();
app.locals.rooms = rooms;

let httpsServer: https.Server;
let io: socketio.Server;

async function run() {
	await runHttpsServer();
	await runWebSocketServer();

	setInterval(() => {
		let all = 0;
		let closed = 0;

		rooms.forEach(room => {
			all++;
			if ( room.closed ) {
				closed++;
			}
			logger.debug(JSON.stringify(room.statusReport()));
		});

		logger.info('room total: %s, closed: %s', all, closed);
	}, 300000);

	// check for deserted rooms
	setInterval(() => {
		rooms.forEach(room => room.checkDeserted());
	}, 10000);
}

const runHttpsServer = () => {
	app.use('/', express.static('web', {
		maxAge: '-1'
	}));

	app.get('*', (req,res,next) => {
		res.status(404).send({res: '404'});
	});

	// httpsServer = https.createServer(tls, app);
	// httpsServer.listen(443, () => {
	// 	logger.info(`Listening at 443...`);
	// });
	http.createServer(app).listen(9001);
}

const runWebSocketServer = async () => {
	io = socketio.listen(httpsServer, {
		pingTimeout: 3000,
		pingInterval: 5000,
	});

	logger.info("Running socketio server....");

	io.on('connection', async (socket) => {
		const { roomId, peerId } = socket.handshake.query;

		if (!roomId || !peerId) {
			logger.warn('connection request without roomId and/or peerId');
			socket.disconnect(true);
			return;
		}

		logger.info('connection request [roomId:"%s", peerId:"%s"]', roomId, peerId);

		try {
			const room = await getOrCreateRoom(roomId);
			let peer = room.getPeer(peerId);

			if (!peer) {
				peer = new Peer(peerId, socket, room);
				room.handlePeer(peer);
				logger.info('new peer, %s, %s', peerId, socket.id);
			} else {
				peer.handlePeerReconnect(socket);
				logger.info('peer reconnect, %s, %s', peerId, socket.id);
			}
		} catch(error) {
				logger.error('room creation or room joining failed [error:"%o"]', error);
				socket.disconnect(true);
				return;
		};
	});
}

const getOrCreateRoom = async (roomId: string) => {
	let room = rooms.get(roomId);

	if (!room) {
		logger.info('creating a new Room [roomId:"%s"]', roomId);


		room = await Room.create( roomId );

		rooms.set(roomId, room);
		room.on('close', () => rooms.delete(roomId));
	}

	return room;
}

run();
