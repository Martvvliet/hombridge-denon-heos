const request = require('request');
const parseString = require('xml2js').parseString;
const telnet = require('telnet-client');

/* Include lib */
const discover = require('./lib/discover');

const pluginName = 'homebridge-denon-heos';
const platformName = 'DenonAVR';
const pluginVersion = '2.9.0';

const defaultPollingInterval = 3;
const infoRetDelay = 250;
const defaultTrace = false;
const autoDiscoverTime = 3000;
const setAVRState = false;
/* Setup settings button and info button */
const infoMenu = 'MNINF';
const settingsMenu = 'MNMEN ON';

let Service;
let Characteristic;
let Accessory;
let UUIDGen;

var traceOn;
var debugToInfo;
var discoverDev;
var g_log;

var foundReceivers = [];
var cachedAccessories = [];

var didFinishLaunching = false;

/* Variables for telnet polling system */
var g_powerState = [false,false,false];
var g_volLevel = [0,0,0];
var g_muteState = [false,false,false];
var g_inputID = [null,null,null];

module.exports = (homebridge) => {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	Accessory = homebridge.platformAccessory;
	UUIDGen = homebridge.hap.uuid;

	homebridge.registerPlatform(pluginName, platformName, denonClient, true);
};

exports.logDebug = function(string) {
	if (!debugToInfo)
		g_log.debug(string);
	else 
		g_log.warn(string);
}
function logDebug(string) {
	if (!debugToInfo)
		g_log.debug(string);
	else 
		g_log.warn(string);
}

class denonClient {
	constructor(log, config, api) {
		g_log = log;
		this.port = 3000;
		this.api = api;

		/* Stop loading if plugin is not configured */
		if (!config || (!Array.isArray(config.devices) && !Array.isArray(config.switches) && !Array.isArray(config.volumeControl))) {
			g_log.warn("WARNING: No config settings found for homebridge-denon-heos plugin.")
			return;
		}

		traceOn = config.debugTrace || defaultTrace;

		debugToInfo = config.debugToInfo || false;

		/* Search for all available Denon receivers */
		discoverDev = new discover(this, g_log, foundReceivers, autoDiscoverTime, pluginVersion);

		api.on('didFinishLaunching', function() {
			logDebug("DidFinishLaunching");
			didFinishLaunching = true;

			this.configReceivers = [];

			try {
				for (let i in config.switches) {
					if (config.switches[i].ip !== undefined && !this.configReceivers[config.switches[i].ip] )
						this.configReceivers[config.switches[i].ip] = new receiver(this, config, config.switches[i].ip);
				}
			} catch {
				g_log.error("ERROR: Could not setup switches")
				return;
			}
	
			try {
				for (let i in config.devices) {
					if (config.devices[i].ip !== undefined && !this.configReceivers[config.devices[i].ip])
						this.configReceivers[config.devices[i].ip] = new receiver(this, config, config.devices[i].ip);
				}
			} catch {
				g_log.error("ERROR: Could not setup devices")
				return;
			}
	
			try {
				for (let i in config.volumeControl) {
					if (config.volumeControl[i].ip !== undefined && !this.configReceivers[config.volumeControl[i].ip]){
						this.configReceivers[config.volumeControl[i].ip] = new receiver(this, config, config.volumeControl[i].ip);}
	
				}
			} catch {
				g_log.error("ERROR: Could not setup volume control")
				return;
			}

			setTimeout(this.removeCachedAccessory.bind(this), autoDiscoverTime+5000);
		}.bind(this));
	}

	configureAccessory(platformAccessory){
		if (traceOn) {
			logDebug('DEBUG: configureAccessory');
			try {
				logDebug(platformAccessory.displayName);
			} catch {
			}
		}

		cachedAccessories.push(platformAccessory);
	}
	
	removeCachedAccessory(){
		if (traceOn) {
			logDebug('DEBUG: removeCachedAccessory');
			try {
				for (let i in cachedAccessories) 
					logDebug(cachedAccessories[0].displayName);
			} catch {
			}
		}

		try {
			this.api.unregisterPlatformAccessories(pluginName, platformName, cachedAccessories);
		} catch {
			g_log.error("ERROR: Could not unregister accessories.");
		}
	}
}

class receiver {
	constructor(base, config, ip) {
		this.port = 3000;
		this.api = base.api;
		this.ip = ip;
		this.base = base;

		this.tvAccessories = [];
		this.legacyAccessories = [];
		this.volumeAccessories = [];

		this.switches = config.switches;
		this.devices = config.devices;
		this.volumeControl = config.volumeControl;

		this.devicesDuplicates = [];
		this.switchesDuplicates = [];
		this.volumeCtrlDuplicates = [];

		logDebug('DEBUG: Start receiver with ip: ' + this.ip);

		this.pollingInterval = config.pollInterval || defaultPollingInterval;
		this.pollingInterval = this.pollingInterval * 1000;

		this.htmlControl = true;
		this.telnetPort = 23;
		this.devInfoSet = false;
		this.controlProtocolSet = false;
		this.telnetConnection;

		this.manufacturer = 'Denon';
		this.modelName = pluginName;
		this.serialNumber = 'MVV123';
		this.firmwareRevision = pluginVersion;

		this.disableReceiver = false;
		this.pollingTimeout = false;
		this.usesManualPort = false;

		this.webAPIPort = null;
		this.checkAliveInterval = null;

		this.zTwoEn = false;
		this.zThreeEn = false;

		this.poweredOn = [false,false,false];
		this.currentInputID = [null,null,null];
		this.volDisp = [null,null,null];
		this.volumeLevel = [30,30,30];
		this.muteState = [false,false,false];

		this.getPortSettings();

		// this.startConfiguration();
	}

	getDevInfoSet() {
		return this.devInfoSet;
	}
	setDevInfoSet(set) {
		this.devInfoSet = set;
	}
	returnIP() {
		return this.ip;
	}
	returnPort() {
		return this.webAPIPort;
	}
	hasManualPort() {
		return this.usesManualPort;
	}
	setDisableReceiver(set) {
		g_log.error('ERROR: Receiver with IP: ' + this.ip + " is disabled. Can't connect through http or Telnet.")
		this.disableReceiver = set;
	}

	getPortSettings() {
		/* Configure switches */
		for (var i in this.switches) {
			if (this.switches[i].ip === this.ip) {

				if (this.webAPIPort === null || this.webAPIPort === 'auto') {
					this.webAPIPort = this.switches[i].port || 'auto';
					if(this.webAPIPort != 'auto') 
						this.webAPIPort = this.webAPIPort.toString();
				} else {
					let temp = this.switches[i].port || 'auto';
					if(temp != 'auto') {
						temp = temp.toString();
						if (temp != this.webAPIPort) {
							g_log.error('ERROR: Some manual port number are not equal in config file with receiver: %s', this.ip)
						}
					}
				}
			}
		}

		/* Configure devices */
		for (let i in this.devices) {
			if (this.devices[i].ip === this.ip) {
				if (this.webAPIPort === null || this.webAPIPort === 'auto') {
					this.webAPIPort = this.devices[i].port || 'auto';
					if(this.webAPIPort != 'auto') 
						this.webAPIPort = this.webAPIPort.toString();
				} else {
					let temp = this.devices[i].port || 'auto';
					if(temp != 'auto') {
						temp = temp.toString();
						if (temp != this.webAPIPort) {
							g_log.error('ERROR: Some manual port number are not equal in config file with receiver: %s', this.ip)
						}
					}
				}
			}	
		}

		/* Configure volumeControl */
		for (let i in this.volumeControl) {
			if (this.volumeControl[i].ip === this.ip) {
				if (this.webAPIPort === null || this.webAPIPort === 'auto') {
					this.webAPIPort = this.volumeControl[i].port || 'auto';
					if(this.webAPIPort != 'auto') 
						this.webAPIPort = this.webAPIPort.toString();
				} else {
					let temp = this.volumeControl[i].port || 'auto';
					if(temp != 'auto') {
						temp = temp.toString();
						if (temp != this.webAPIPort) {
							g_log.error('ERROR: Some manual port number are not equal in config file with receiver: %s', this.ip)
						}
					}
				}
			}	
		}

		if(this.webAPIPort === 'auto') {
			this.discoverControlInterface();
		} else if (this.webAPIPort === 'telnet') {
			this.htmlControl = false;
			logDebug('DEBUG: Manual control through Telnet set: ' + this.ip);
			this.controlProtocolSet = true;
			this.startConfiguration();
		} else {
			this.usesManualPort = true;
			if(!this.webAPIPort.includes('80')) {
				g_log.error('ERROR: Current port %s with ip: %s, is not suitable. Use 80 or 8080 manually instead.', this.webAPIPort, this.ip);
			}
			logDebug('DEBUG: Manual port ' + this.webAPIPort + ' set: ' + this.ip);
			this.controlProtocolSet = true;
			this.startConfiguration();
		}
	}

	/* 
	 * Try to connect through html interface. If not possible go for Telnet.
	 */
	discoverControlInterface () {
		var that = this;
		/* Try connecting through port 80 */
		request('http://' + that.ip + ':80/goform/formMainZone_MainZoneXmlStatusLite.xml', function(error, response, body) {
			if(error || body.indexOf('Error 403: Forbidden') === 0) {
				/* Try connecting through port 8080 as 80 could not conenct. */
				request('http://' + that.ip + ':8080/goform/formMainZone_MainZoneXmlStatusLite.xml', function(error, response, body) {
					if(error || body.indexOf('Error 403: Forbidden') === 0) {
						/* Html control is not possible. Connect through Telnet */
						logDebug('DEBUG: No html control possible. Use Telnet control.')
						that.htmlControl = false;
					} else {
						g_log('Using http control on port 8080 with receiver: '  + that.ip);
						that.webAPIPort = '8080';
						that.controlProtocolSet = true;
					}
					that.startConfiguration();
				});
			} else {
				g_log('Using http control with on 80 with receiver: '  + that.ip);
				that.webAPIPort = '80';
				that.controlProtocolSet = true;
				that.startConfiguration();
			}
		});
	}

	/* 
	 * Try configure the devices. Wait until receiver discovery is finished.
	 */
	startConfiguration () {
		if (this.disableReceiver)
			return;

		if (!discoverDev.setDenonInformation(this, g_log) || !didFinishLaunching) {
			setTimeout(this.startConfiguration.bind(this), infoRetDelay);
			return;
		}	

		if (!this.htmlControl)
			this.connectTelnet();

		/* Configure switches */
		for (var i in this.switches) {
			if (this.switches[i].ip === this.ip) {
				try {
					if (this.switchesDuplicates[this.switches[i].name]) {
						g_log.warn("WARNING: A Switch with the name: %s and ip: %s is already added. It will be ignored.", this.switches[i].name, this.switches[i].ip);
						continue;
					} else {
						this.switchesDuplicates[this.switches[i].name] = true;
						this.legacyAccessories.push(new legacyClient(this, this.switches[i]));
					}
				} catch {
					g_log.error("ERROR: Could not add Switch accessory.");
				}
			}
		}

		/* Configure devices */
		for (let i in this.devices) {
			if (this.devices[i].ip === this.ip) {
				try {
					if (this.devicesDuplicates[this.devices[i].name]) {
						g_log.warn("WARNING: A Device with the name: %s and ip: %s is already added. It will be ignored.", this.devices[i].name, this.devices[i].ip);
						continue;
					} else {
						this.devicesDuplicates[this.devices[i].name] = true;
						this.tvAccessories.push(new tvClient(this, this.devices[i]));
					}
				} catch {
					g_log.error("ERROR: Could not add TV accessory.");
				}
			}
		}

		/* Configure volumeControl */
		for (let i in this.volumeControl) {
			if (this.volumeControl[i].ip === this.ip) {
				try {
					if (this.volumeCtrlDuplicates[this.volumeControl[i].name]) {
						g_log.warn("WARNING: A Volume control with the name: %s and ip: %s is already added. It will be ignored.", this.volumeControl[i].name, this.volumeControl[i].ip);
						continue;
					} else {
						this.volumeCtrlDuplicates[this.volumeControl[i].name] = true;
						this.volumeAccessories.push(new volumeClient(this, this.volumeControl[i]));
					}
				} catch (err) {
					g_log.error("ERROR: Could not add Volume control accessory.", err);
				}
			}
		}
			
		/* start the polling */
		setTimeout(this.startPolling, Math.random() * 3000, this);
	}

	/*
	 * Diverted start of polling loop.
	 */
	startPolling (that) {
		if (!that.checkAliveInterval) {
			that.checkAliveInterval = setInterval(that.pollForUpdates.bind(that, 1), that.pollingInterval);
		}
	}

	/*
	 * This will start a polling loop that goes on forever and updates
	 * the on characteristic periodically.
	 */
	pollForUpdates(zone) {
		if (!this.controlProtocolSet)
			return;

		// if (traceOn)
		// 	logDebug('DEBUG: pollForUpdates zone: ' + zone + ': ' + this.ip);

		/* Make sure that no poll is happening just after switch in input/power */
		if (this.pollingTimeout) {
			this.pollingTimeout = false;
			return;
		}

		var that = this;

		if (this.htmlControl) {
			var requestString
			if (zone == 1) 
				requestString = 'http://' + that.ip + ':' + this.webAPIPort + '/goform/formMainZone_MainZoneXmlStatusLite.xml';
			else if (zone == 2 || zone == 3) 
				requestString = 'http://' + that.ip + ':' + this.webAPIPort + '/goform/formZone' + zone + '_Zone' + zone + 'XmlStatusLite.xml';
			
			
			request(requestString, function(error, response, body) {
				if(error) {
					g_log.error("ERROR: Can't connect to receiver with ip: %s and port: %s", that.ip, that.webAPIPort);
					logDebug('DEBUG: ' + error);
				} else if (body.indexOf('Error 403: Forbidden') === 0) {
					g_log.error('ERROR: Can not access receiver with IP: %s. Might be due to a wrong port. Try 80 or 8080 manually in config file.', that.ip);
				} else {
					parseString(body, function (err, result) {
						if(err) {
							logDebug("DEBUG: Error while parsing pollForUpdates. " + err);
						}
						else {	
							try {
								if (that.volDisp[zone] === null)
									that.volDisp[zone] = result.item.VolumeDisplay[0].value[0];
							} catch(error) {
								that.volDisp[zone] = 'Absolute';
							}

							let powerState = false;
							try {
								if (result.item.Power[0].value[0] === 'ON' )
									powerState = true; 
							} catch(error) {
								g_log.error('ERROR: Could not retrieve powerstate. Might be due to a wrong ip address.');
								return;
							}

							/* Parse volume of receiver to 0-100% */
							let volLevel;
							try {
								if ( that.volDisp[zone] === 'Absolute' ) {
									volLevel = parseInt(result.item.MasterVolume[0].value[0]);
									volLevel = volLevel + 80;
								}
							} catch(error) {
								g_log.error('ERROR: Could not retrieve volume level. Might be due to a wrong ip address.');
								return;
							}

							/* Parse mutestate receiver to bool of HB */
							let muteState = false;
							try {
								if (result.item.Mute[0].value[0] === 'on' )
									muteState = true;
							} catch(error) {
								g_log.error('ERROR: Could not retrieve mute state. Might be due to a wrong ip address.');
								return;
							}

							let stateInfo = {
								zone: zone,
								power: powerState,
								inputID: result.item.InputFuncSelect[0].value[0],
								masterVol: volLevel,
								mute: muteState
							}

							if (!that.pollingTimeout)
								that.updateStates(that, stateInfo, null);
							
							if (zone == 1 && that.zTwoEn)
								that.pollForUpdates(2);
							else if (zone == 2 && that.zThreeEn)
								that.pollForUpdates(3);
						}
					});
				}
			});
		} else {
			that.telnetConnection.send('PW?');
			this.telnetConnection.send('MU?');
			this.telnetConnection.send('MV?');
			this.telnetConnection.send('SI?');
			if (that.zTwoEn) {
				this.telnetConnection.send('Z2MU?');
				that.telnetConnection.send('Z2?');
			}
			if (that.zThreeEn) {
				this.telnetConnection.send('Z3MU?');
				that.telnetConnection.send('Z3?');		
			}
		}
	}


	/*
	 * Used to update the state of all. Disable polling for one poll.
	 */
	updateStates(that, stateInfo, curName) {
		if (curName)
			that.pollingTimeout = true;

			
		if (stateInfo.masterVol == undefined)
			stateInfo.masterVol = 0;

		if (traceOn)
			logDebug(stateInfo);

		if (stateInfo.power === true || stateInfo.power === false)
			that.poweredOn[stateInfo.zone-1] = stateInfo.power;

		if (stateInfo.inputID)
			that.currentInputID[stateInfo.zone-1] = stateInfo.inputID;

		if (stateInfo.mute === true || stateInfo.mute === false)
			that.muteState[stateInfo.zone-1] = stateInfo.mute;
		
		if (stateInfo.masterVol)
			that.volumeLevel[stateInfo.zone-1] = stateInfo.masterVol;

		for (let i in that.legacyAccessories) {
			if (that.legacyAccessories[i].getName() != curName) {
				that.legacyAccessories[i].setReceiverState(stateInfo);
			}
		}

		for (let i in that.tvAccessories) {
			if (that.tvAccessories[i].getName() != curName) {
				that.tvAccessories[i].setReceiverState(stateInfo);
			}
		}

		for (let i in that.volumeAccessories) {
			if (that.volumeAccessories[i].getName() != curName) {
				that.volumeAccessories[i].setReceiverState(stateInfo);
			}
		}
		
	}

	/*
	 * Setup Telnet connection if no HTML control is possible.
	 */
	connectTelnet() {
		this.telnetConnection = new telnet();

		this.telnetConnection.on('connect', () => {
            this.connected = true;
            logDebug('DEBUG" connected to ' + this.ip);
        });

        this.telnetConnection.on('close', () => {
            this.connected = false;
            logDebug('DEBUG: lost connection to ' + this.ip);
			if (this.attempts > 5){
				g_log.Error("ERROR: Can't connect to receiver with IP: " + this.ip);
			}
            setTimeout(() => {
                connect();
            }, 2000);
        });

        this.telnetConnection.on('error', err => {
            // the close event will be called, too
            g_log.error(err);
        });

        this.telnetConnection.on('failedLogin', () => {
            g_log.error("ERROR: Can't login at receiver with IP: " + this.ip);
		});

		this.telnetConnection.on('data', data =>
            this.telnetResponseHandler(data.toString('utf8').replace(/\r?\n|\r/gm, ''))
        );
		
		connect(this);
	}
	
	send(cmd) {
        if (cmd && this.queue.length) {
            logDebug('DEBUG: pushed command to queue');
            this.queue.push(cmd);
            return;
        }

        if (!cmd && this.queue.length) {
            logDebug('DEBUG: get cmd from queue');
            cmd = this.queue[0];
            this.queue.shift();
        }

        this.telnetConnection
            .send(cmd + '\r')
            .then(() => {
                logDebug('DEBUG: command ' + cmd + ' successfully send');
                if (this.queue.length) setTimeout(() => this.send(), 100);
            })
            .catch(err => {
                logDebug('DEBUG: error: ' + err);
                if (this.queue.length) setTimeout(() => this.send(), 100);
            });
    }

	telnetResponseHandler(res) {
        const regExp = /MUON|MUOFF|PWON|PWSTANDBY|MV\d{1,3}|SI\S{1,10}|Z2MUON|Z2MUOFF|Z2ON|Z2OFF|Z2\d{1,3}|Z2\S{1,10}|Z3MUON|Z3MUOFF|Z3ON|Z3OFF|Z3\d{1,3}|Z3\S{1,10}/gm;
        res = res.match(regExp);

        if (!Array.isArray(res)) return;

        for (let i = 0; i < res.length; i++) {
            // logDebug('DEBUG: received response: ' + res[i]);

            switch (res[i].slice(0,2)) {
                case 'PW':
					if (res[i] === 'PWON')
						g_powerState[0] = true; 
					else if (res[i] === 'PWSTANDBY')
						g_powerState[0] = false; 
					break;

				case 'MV':
					if (res[i] === /MV\d{1,3}/g.exec(res[i])[0]) {
						g_volLevel[0] = parseInt(/\d{1,3}/g.exec(res[i])[0]);
					}
					break;

                case 'MU':
					if (res[i] === 'MUON')
						g_muteState[0] = true; 
					else if (res[i] === 'MUOFF')
						g_muteState[0] = false; 
					break;

				case 'SI':
					if (res[i].slice(0,7) === 'SINFAIS') {
						break;
					}
					if (res[i] === /SI\S{1,20}/g.exec(res[i])[0]) {
						let stateInfo = {
							zone: 1,
							power: g_powerState[0],
							inputID: res[i].slice(2),
							masterVol: g_volLevel[0],
							mute: g_muteState[0]
						}
						if (!this.pollingTimeout)
							this.updateStates(this, stateInfo, null);
					}
					break;
				case 'Z2':
					if (res[i] === 'Z2ON')
						g_powerState[1] = true; 
					else if (res[i] === 'Z2OFF')
						g_powerState[1] = false; 
					else if (res[i] === 'Z2MUON')
						g_muteState[1] = true; 
					else if (res[i] === 'Z2MUOFF')
						g_muteState[1] = false; 
					else if (res[i].slice(2,9) === 'SINFAIS')
						break;
					else if (parseInt(res[i].slice(2)) == parseInt(res[i].slice(2))) {
						let stateInfo = {
							zone: 2,
							power: g_powerState[1],
							inputID: g_inputID[1],
							masterVol: parseInt(res[i].slice(2,5)),
							mute: g_muteState[1]
						}
						if (!this.pollingTimeout)
							this.updateStates(this, stateInfo, null);
					}
					else if (res[i] === /Z2\S{1,20}/g.exec(res[i])[0])
						g_inputID[1] = res[i].slice(2);
					break;
				case 'Z3':
					if (res[i] === 'Z3ON')
						g_powerState[2] = true; 
					else if (res[i] === 'Z3OFF')
						g_powerState[2] = false; 
					else if (res[i] === 'Z3MUON')
						g_muteState[2] = true; 
					else if (res[i] === 'Z3MUOFF')
						g_muteState[2] = false; 
					else if (res[i].slice(2,9) === 'SINFAIS')
						break;
					else if (parseInt(res[i].slice(2)) == parseInt(res[i].slice(2))) {
						let stateInfo = {
							zone: 2,
							power: g_powerState[2],
							inputID: g_inputID[2],
							masterVol: parseInt(res[i].slice(2,5)),
							mute: g_muteState[2]
						}
						if (!this.pollingTimeout)
							this.updateStates(this, stateInfo, null);
					}
					else if (res[i] === /Z3\S{1,20}/g.exec(res[i])[0])
						g_inputID[2] = res[i].slice(2);
					break;
			}
        }
    }
}

connect = async (that) => {
	that.attempts++;

	const params = {
		host: that.ip,
		port: 23,
		echoLines: 0,
		irs: '\r',
		negotiationMandatory: false,
		ors: '\r\n',
		separator: false,
		shellPrompt: '',
		timeout: 800,
	};

	await that.telnetConnection.connect(params);
	that.connected = true;
	that.attempts = 0;
	that.controlProtocolSet = true;
	g_log('Using Telnet control with receiver: '  + that.ip);
};

class tvClient {
	constructor(recv, device) {
		this.port = 3000;
		this.api = recv.api;
		this.recv = recv;

		this.tvServicePort = recv.webAPIPort;

		this.manufacturer = recv.manufacturer;
		this.modelName = recv.modelName;
		this.serialNumber = recv.serialNumber;
		this.firmwareRevision = recv.firmwareRevision;

		// configuration
		this.name = device.name || 'Denon Receiver';
		this.ip = device.ip;
		this.inputs = device.inputs;
		this.zone = device.zone || 1;
		if (this.zone < 1 || this.zone > 3)
			this.zone = 1;

		if (this.zone == 2)
			this.recv.zTwoEn = true;
		if (this.zone == 3)
			this.recv.zThreeEn = true;

		this.iterator = this.zone - 1;
		this.defaultVolume = {};
		
		this.switchInfoMenu = device.switchInfoMenu;
		if (this.switchInfoMenu === true) {
			this.infoButton = settingsMenu;
			this.menuButton = infoMenu;
		} else {
			this.infoButton = infoMenu;
			this.menuButton = settingsMenu;
		}

		this.defaultInputID = device.defaultInputID;

		/* setup variables */
		this.inputIDSet = false;
		this.inputIDs = new Array();

		this.setDefaultInputTimeout;
		
		/* Delay to wait for retrieve device info */
		this.setupTvService();
	}


	/*****************************************
	 * Start of TV integration service 
	 ****************************************/
	setupTvService() {
		if (traceOn)
			logDebug('DEBUG: setupTvService zone: ' + this.zone + ': ' + this.name);

		this.tvAccesory = new Accessory(this.name, UUIDGen.generate(this.ip+this.name+"tvService"));
		this.tvAccesory.category = this.api.hap.Categories.AUDIO_RECEIVER;
		

		this.tvService = new Service.Television(this.name, 'tvService');
		this.tvService
			.setCharacteristic(Characteristic.ConfiguredName, this.name);
		this.tvService
			.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
		this.tvService
			.getCharacteristic(Characteristic.Active)
			.on('get', this.getPowerState.bind(this))
			.on('set', this.setPowerState.bind(this));
		this.tvService
			.getCharacteristic(Characteristic.ActiveIdentifier)
			.on('set', (inputIdentifier, callback) => {
				this.setAppSwitchState(true, callback, this.inputIDs[inputIdentifier]);
			})
			.on('get', this.getAppSwitchState.bind(this));
		this.tvService
			.getCharacteristic(Characteristic.RemoteKey)
			.on('set', this.remoteKeyPress.bind(this));
		this.tvService
			.getCharacteristic(Characteristic.PowerModeSelection)
			.on('set', (newValue, callback) => {
				if (this.recv.poweredOn[this.iterator]) {

					request('http://' + this.ip + ':' + this.tvServicePort + '/goform/formiPhoneAppDirect.xml?' + this.menuButton, function(error, response, body) {});
				} 
				callback();
			});

		
		this.tvAccesory
			.getService(Service.AccessoryInformation)
			.setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
			.setCharacteristic(Characteristic.Model, this.modelName)
			.setCharacteristic(Characteristic.SerialNumber, this.serialNumber)
			.setCharacteristic(Characteristic.FirmwareRevision, this.firmwareRevision);

		this.tvAccesory.addService(this.tvService);

		this.setupTvSpeakerService();
		this.setupInputSourcesService();


		logDebug('DEBUG: publishExternalAccessories zone: ' + this.zone + ': ' + this.name);
		this.api.publishExternalAccessories(pluginName, [this.tvAccesory]);
	}

	setupTvSpeakerService() {
		if (traceOn)
			logDebug('DEBUG: setupTvSpeakerService zone: ' + this.zone + ': ' + this.name);
		this.tvSpeakerService = new Service.TelevisionSpeaker(this.name + ' Volume', 'tvSpeakerService');
		this.tvSpeakerService
			.setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
			.setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE);
		this.tvSpeakerService
			.getCharacteristic(Characteristic.VolumeSelector)
			.on('set', (state, callback) => {
				logDebug('DEBUG: Remote control (VolumeSelector), pressed: ' + state === 1 ? 'Down' : 'Up');
				this.setVolumeSwitch(state, callback, !state);
			});
		this.tvSpeakerService
			.getCharacteristic(Characteristic.Volume)
			.on('get', this.getVolume.bind(this))
			.on('set', this.setVolume.bind(this));
		this.tvSpeakerService
			.getCharacteristic(Characteristic.Mute)
			.on('get', this.getMuteState.bind(this))
			.on('set', this.setMuteState.bind(this));
		
		this.tvAccesory.addService(this.tvSpeakerService);
		this.tvService.addLinkedService(this.tvSpeakerService);
	}

	setupInputSourcesService() {
		if (traceOn)
			logDebug('DEBUG: setupInputSourcesService zone: ' + this.zone + ': ' + this.name);
		if (this.inputs === undefined || this.inputs === null || this.inputs.length <= 0) {
			return;
		}

		if (Array.isArray(this.inputs) === false) {
			this.inputs = [this.inputs];
		}

		let savedNames = {};

		this.inputs.forEach((value, i) => {

			// get inputID
			let inputID = null;

			if (value.inputID !== undefined) {
				inputID = value.inputID;
			} else {
				inputID = value;
			}

			// get name		
			let inputName = inputID;

			if (savedNames && savedNames[inputID]) {
				inputName = savedNames[inputID];
			} else if (value.name) {
				inputName = value.name;
			}

			this.defaultVolume[inputID] = 0
			if (value.defaultVolume !== undefined) {
				this.defaultVolume[inputID] = value.defaultVolume;
			}

			// if inputID not null or empty add the input
			if (inputID !== undefined && inputID !== null && inputID !== '') {
				inputID = inputID.replace(/\s/g, ''); // remove all white spaces from the string

				let tempInput = new Service.InputSource(inputID, 'inputSource' + i);
				tempInput
					.setCharacteristic(Characteristic.Identifier, i)
					.setCharacteristic(Characteristic.ConfiguredName, inputName)
					.setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
					.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.APPLICATION)
					.setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);

				tempInput
					.getCharacteristic(Characteristic.ConfiguredName)
					.on('set', (name, callback) => {
						savedNames[inputID] = name;
						callback()
					});

				this.tvAccesory.addService(tempInput);
				if (!tempInput.linked)
					this.tvService.addLinkedService(tempInput);
				this.inputIDs.push(inputID);
			}

		});
	}	
	/*****************************************
	* End of TV integration service 
	****************************************/


	/*****************************************
	 * Start of helper methods
	 ****************************************/
	updateReceiverState(tvStatus) {
		if (!tvStatus) {
			if (this.powerService) 
				this.powerService
					.getCharacteristic(Characteristic.On)
					.updateValue(false);
			if (this.tvService) 
				this.tvService
					.getCharacteristic(Characteristic.Active)
					.updateValue(false); //tv service
			if (this.volumeService) {
				this.volumeService
					.getCharacteristic(Characteristic.On)
					.updateValue(false);
				this.volumeService
					.getCharacteristic(Characteristic.Volume)
					.updateValue(this.recv.volumeLevel[this.iterator]);
				this.volumeService
					.getCharacteristic(Characteristic.Mute)
					.updateValue(false);
			}
		} else {
			if (this.powerService) 
				this.powerService
					.getCharacteristic(Characteristic.On)
					.updateValue(true);
			if (this.tvService)
				this.tvService
					.getCharacteristic(Characteristic.Active)
					.updateValue(true); //tv service
			if (this.volumeService) {
				this.volumeService
					.getCharacteristic(Characteristic.On)
					.updateValue(true);
				this.volumeService
					.getCharacteristic(Characteristic.Volume)
					.updateValue(this.recv.volumeLevel[this.iterator]);
				this.volumeService
					.getCharacteristic(Characteristic.Mute)
					.updateValue(this.recv.muteState[this.iterator]);
			}
		}
	}

	setReceiverState(stateInfo) {
		if (this.zone != stateInfo.zone)
			return;

		if (traceOn && setAVRState)
			logDebug('DEBUG: setReceiverState zone: ' + this.zone + ': ' + this.name); 
		
		if (stateInfo.power === true || stateInfo.power === false)
			this.updateReceiverState(this.recv.poweredOn[this.iterator]);

		if (stateInfo.inputID) {
			if (this.recv.poweredOn[this.iterator]) {
				let inputName = stateInfo.inputID;
				for (let i = 0; i < this.inputIDs.length; i++) {
					if (inputName === this.inputIDs[i]) {
						if (this.inputIDSet === false)
							this.tvService
								.getCharacteristic(Characteristic.ActiveIdentifier)
								.updateValue(i);
						else 
							this.inputIDSet = false;	
					}
				}
			}
		}
	}
	/*****************************************
	 * End of helper methods
	 ****************************************/

 	/*****************************************
	 * Start of Homebridge Setters/Getters
	 ****************************************/
	getPowerState(callback) {
		if (traceOn)
			logDebug('DEBUG: getPowerState zone: ' + this.zone + ': ' + this.name);

		callback(null, this.recv.poweredOn[this.iterator] ? 1 : 0);
	}

	setPowerState(state, callback) {
		if (traceOn)
			logDebug('DEBUG: setPowerState zone: ' + this.zone + 'state: ' + this.name);

		if (state === 0)
			state = false;
		else if (state === 1)
			state = true;
	
				
		if (this.recv.htmlControl) {
			var that = this;
			var stateString = (state ? 'On' : 'Standby');

			request('http://' + that.ip + ':' + this.tvServicePort + '/goform/formiPhoneAppPower.xml?' + that.zone + '+Power' + stateString, function(error, response, body) {
				if(error) {
					g_log.error("ERROR: Can't connect to receiver with ip: %s and port: %s", that.ip, that.tvServicePort);
					logDebug('DEBUG: ' + error);
					callback(error);
				} else if (body.indexOf('Error 403: Forbidden') === 0) {
					g_log.error('ERROR: Can not access receiver with IP: %s. Might be due to a wrong port. Try 80 or 8080 manually in config file.', that.ip);
				} else {
					if (state && that.defaultInputID != undefined && that.defaultInputID != "None") {				
						that.setDefaultInputTimeout = setTimeout(function(){
							that.setAppSwitchState(state, callback, that.defaultInputID);
						}, 8000);
					} else {
						clearTimeout(that.setDefaultInputTimeout);
						/* Update possible other switches and accessories too */
						let stateInfo = {
							zone: that.zone,
							power: state,
							inputID: null,
							masterVol: null,
							mute: null
						}
						that.recv.updateStates(that.recv, stateInfo, that.name);

						callback();
					}
				}
			});
		} else {
			var stateString;
			if (this.zone == 1)
				stateString = 'PW' + (state ? 'ON' : 'STANDBY');
			else if (this.zone == 2 || this.zone == 3)
				stateString = 'Z' + this.zone + (state ? 'ON' : 'OFF');
			
			this.recv.telnetConnection.send(stateString); 
				
			/* Update possible other switches and accessories too */
			let stateInfo = {
				zone: this.zone,
				power: state,
				inputID: null,
				masterVol: null,
				mute: null
			}
			this.recv.updateStates(this.recv, stateInfo, this.name);

			callback();
		}
	}
	

	// getVolumeSwitch(callback) {
	// 	if (traceOn)
	// 		logDebug('DEBUG: getVolumeSwitch: ' + this.name);
	// 	callback(null, false);
	// }

	setVolumeSwitch(state, callback, isUp) {
		if (traceOn)
			logDebug('DEBUG: setVolumeSwitch zone: ' + this.zone + ': ' + this.name);

		var zoneString;
		if (this.zone == 1) 
			zoneString = 'MV';
		else if (this.zone == 2 || this.zone == 3) 
			zoneString = 'Z' + this.zone;

		var that = this;
		if (this.recv.poweredOn[this.iterator]) {
			var stateString = zoneString + (isUp ? 'UP' : 'DOWN');
						
			if (this.recv.htmlControl) {	
				request('http://' + this.ip + ':' + this.tvServicePort + '/goform/formiPhoneAppDirect.xml?' + stateString, function(error, response, body) {
					if(error) {
						g_log.error("ERROR: Can't connect to receiver with ip: %s and port: %s", that.ip, that.tvServicePort);
						logDebug('DEBUG: ' + error);
					} else if (body.indexOf('Error 403: Forbidden') === 0) {
						g_log.error('ERROR: Can not access receiver with IP: %s. Might be due to a wrong port. Try 80 or 8080 manually in config file.', that.ip);
					} 
				});
			} else {
				that.recv.telnetConnection.send(stateString);
			}
		}
		callback();
	}

	getAppSwitchState(callback) {
		if (traceOn)
			logDebug('DEBUG: getAppSwitchState zone: ' + this.zone);

		if (this.recv.poweredOn[this.iterator]) {
			let inputName = this.recv.currentInputID[this.iterator];
			for (let i = 0; i < this.inputIDs.length; i++) {
				if (inputName === this.inputIDs[i]) {
					this.tvService
						.getCharacteristic(Characteristic.ActiveIdentifier)
						.updateValue(i);
						callback(null, i);
						return;
				}
			}
		}
		callback(null, 0);
	}

	setAppSwitchState(state, callback, inputName) {
		if (traceOn)
			logDebug('DEBUG: setAppSwitchState zone: ' + this.zone + ': ' + this.name);

		this.inputIDSet = true;		

		var level = this.defaultVolume[inputName];

		var inputString;
		var volumeString;
		let inputNameN = inputName.replace('/', '%2F');
		if (this.zone == 1) {
			inputString = 'SI' + inputNameN;
			volumeString = 'MV';
		} else if (this.zone == 2 || this.zone == 3) {
			inputString = 'Z' + this.zone + inputNameN;
			volumeString = 'Z' + this.zone;
		}

		var that = this;

		if (this.recv.htmlControl) {
			request('http://' + that.ip + ':' + this.tvServicePort + '/goform/formiPhoneAppDirect.xml?' + inputString, function(error, response, body) {
				if(error) {
					g_log.error("ERROR: Can't connect to receiver with ip: %s and port: %s", that.ip, that.tvServicePort);
					logDebug('DEBUG: ' + error);
					if (callback)
						callback(error);

				} else if (body.indexOf('Error 403: Forbidden') === 0) {
					g_log.error('ERROR: Can not access receiver with IP: %s. Might be due to a wrong port. Try 80 or 8080 manually in config file.', that.ip);
				} else {
					/* Set default volume if this is set */
					if (level > 0) 
						that.setDefaultVolume(that, level, volumeString);
					
					/* Update possible other switches and accessories too */
					let stateInfo = {
						zone: that.zone,
						power: that.recv.poweredOn[that.iterator],
						inputID: inputName,
						masterVol: null,
						mute: null
					}
					that.recv.updateStates(that.recv, stateInfo, that.name);

					callback();
				}
			});
		} else {

			that.recv.telnetConnection.send(inputString);

			/* Set default volume if this is set */
			if (level > 0) 
				that.setDefaultVolume(that, level, volumeString);
			
			/* Update possible other switches and accessories too */
			let stateInfo = {
				zone: that.zone,
				power: that.recv.poweredOn[that.iterator],
				inputID: inputName,
				masterVol: null,
				mute: null
			}
			that.recv.updateStates(that.recv, stateInfo, that.name);

			callback();
		}
	}

	getMuteState(callback) {
		if (traceOn)
			logDebug('DEBUG: getMuteState: ' + this.name);

		if (this.recv.poweredOn[this.iterator]) {
			callback(null, this.recv.muteState[this.iterator]);
		} else {
			callback(null, false);
		}
	}

	setMuteState(state, callback) {
		if (traceOn)
			logDebug('DEBUG: setMuteState zone: ' + this.zone + ': ' + this.name);

		var stateString;
		if (this.zone == 1)
			stateString = (state ? 'MUON' : 'MUOFF');
		else if (this.zone == 2 || this.zone == 3)
			stateString = 'Z' + this.zone + 'MU' + (state ? 'ON' : 'OFF');

		var that = this;

		if (this.recv.htmlControl) {
			request('http://' + this.ip + ':' + this.tvServicePort + '/goform/formiPhoneAppDirect.xml?' + stateString, function(error, response, body) {
				if(error) {
					g_log.error("ERROR: Can't connect to receiver with ip: %s and port: %s", that.ip, that.tvServicePort);
					logDebug('DEBUG: ' + error);
					callback(error);
				} else if (body.indexOf('Error 403: Forbidden') === 0) {
					g_log.error('ERROR: Can not access receiver with IP: %s. Might be due to a wrong port. Try 80 or 8080 manually in config file.', that.ip);
				} else {
					let stateInfo = {
						zone: that.zone,
						power: null,
						inputID: null,
						masterVol: null,
						mute: state
					}
					that.recv.updateStates(that.recv, stateInfo, that.name);

					callback();
				}
			});
		} else {
			that.recv.telnetConnection.send(stateString);
			/* Update possible other switches and accessories too */
			let stateInfo = {
				zone: that.zone,
				power: null,
				inputID: null,
				masterVol: null,
				mute: state
			}
			that.recv.updateStates(that.recv, stateInfo, that.name);

			callback();
		}
	}

	getVolume(callback) {	
		if (traceOn)
			logDebug('DEBUG: getVolume zone: ' + this.zone + ': ' + this.name);

		if (this.recv.poweredOn[this.iterator]) {
			callback(null, this.recv.volumeLevel[this.iterator]);
		} else {
			callback(null, 0);
		}
	}

	setVolume(level, callback) {		
		if (traceOn)
			logDebug('DEBUG: setVolume: ' + this.name + ' to :' + level);

		this.recv.volumeLevel[this.iterator] = level;
		
		var that = this;
		var denonLevel;
		if (level < 10)
			denonLevel = '0' + level.toString();
		else
			denonLevel = level.toString();

		var zoneSettings;
		if (this.zone == 1)
			zoneSettings = 'MV';
		else if (this.zone == 2 || this.zone == 3)
			zoneSettings = 'Z' + this.zone;

		if (this.recv.htmlControl) {
			request('http://' + that.ip + ':' + this.tvServicePort + '/goform/formiPhoneAppDirect.xml?' + zoneSettings + denonLevel, function(error, response, body) {
				if(error) {
					g_log.error("ERROR: Can't connect to receiver with ip: %s and port: %s", that.ip, that.tvServicePort);
					logDebug('DEBUG: ' + error);
					callback(error);
				} else if (body.indexOf('Error 403: Forbidden') === 0) {
					g_log.error('ERROR: Can not access receiver with IP: %s. Might be due to a wrong port. Try 80 or 8080 manually in config file.', that.ip);
				} else {
					/* Update possible other switches and accessories too */
					let stateInfo = {
						zone: that.zone,
						power: null,
						inputID: null,
						masterVol: level,
						mute: null
					}
					that.recv.updateStates(that.recv, stateInfo, that.name);

					callback();
				}
			});
		} else {
			that.recv.telnetConnection.send(zoneSettings + denonLevel);
			/* Update possible other switches and accessories too */
			let stateInfo = {
				zone: that.zone,
				power: null,
				inputID: null,
				masterVol: level,
				mute: null
			}
			that.recv.updateStates(that.recv, stateInfo, that.name);

			callback();
		}
	}

	setDefaultVolume(that, level, volumeString) {
 		if (level < 10)
		 	volumeString = volumeString + '0' + level.toString();
		else
		volumeString = volumeString + level.toString();

		/* Set default volume if this is set */
		if (that.recv.htmlControl) {
			setTimeout(function(){
				request('http://' + that.ip + ':' + that.tvServicePort + '/goform/formiPhoneAppDirect.xml?' + volumeString, function(error, response, body) {
					if(error) {
						g_log.error("ERROR: Can't connect to receiver with ip: %s and port: %s", that.ip, that.legacyPort);
						logDebug('DEBUG: ' + error);
						callback(error);
					} else {
						/* Update possible other switches and accessories too */
						let stateInfo = {
							zone: that.zone,
							power: null,
							inputID: null,
							masterVol: parseInt(level),
							mute: null
						}
						that.recv.updateStates(that.recv, stateInfo, that.name);
					}
				});
			}, 2000);
		} else {		
			if (level > 0) {
				setTimeout(function(){
					that.recv.telnetConnection.send(volumeString);

					/* Update possible other switches and accessories too */
					let stateInfo = {
						zone: that.zone,
						power: null,
						inputID: null,
						masterVol: parseInt(level),
						mute: null
					}
					that.recv.updateStates(that.recv, stateInfo, that.name);
				}, 2000);
			}
		}
	}

	remoteKeyPress(remoteKey, callback) {
		if (traceOn)
			logDebug('DEBUG: Denon - remote key pressed: ' + remoteKey);
		var ctrlString = '';

		switch (remoteKey) {
			case Characteristic.RemoteKey.REWIND:
				ctrlString = 'MN9E';
				break;
			case Characteristic.RemoteKey.FAST_FORWARD:
				ctrlString = 'MN9D';
				break;
			case Characteristic.RemoteKey.NEXT_TRACK:
				ctrlString = 'MN9F';
				break;
			case Characteristic.RemoteKey.PREVIOUS_TRACK:
				ctrlString = 'MN9G';
				break;
			case Characteristic.RemoteKey.ARROW_UP:
				ctrlString = 'MNCUP';
				break;
			case Characteristic.RemoteKey.ARROW_DOWN:
				ctrlString = 'MNCDN';
				break;
			case Characteristic.RemoteKey.ARROW_LEFT:
				ctrlString = 'MNCLT';
				break;
			case Characteristic.RemoteKey.ARROW_RIGHT:
				ctrlString = 'MNCRT';
				break;
			case Characteristic.RemoteKey.SELECT:
				ctrlString = 'MNENT';
				break;
			case Characteristic.RemoteKey.BACK:
				ctrlString = 'MNRTN';
				break;
			case Characteristic.RemoteKey.EXIT:
				ctrlString = 'MNRTN';
				break;
			case Characteristic.RemoteKey.PLAY_PAUSE:
				ctrlString = 'NS94';
				break;
			case Characteristic.RemoteKey.INFORMATION:
				ctrlString = this.infoButton;
				break;
		}

		if (this.recv.poweredOn[this.iterator]) {
			if (this.recv.htmlControl)
				request('http://' + this.ip + ':' + this.tvServicePort + '/goform/formiPhoneAppDirect.xml?' + ctrlString, function(error, response, body) {});
			else 
				this.recv.telnetConnection.send(ctrlString);
		}
		
		callback();
	}

	getName() {
		return this.name;
	}
	/*****************************************
	* End of Homebridge Setters/Getters
	****************************************/
}

class legacyClient {
	constructor(recv, switches) {
		this.port = 3000;
		this.api = recv.api;
		this.recv = recv;

		this.legacyPort = recv.webAPIPort;

		this.manufacturer = recv.manufacturer;
		this.modelName = recv.modelName;
		this.serialNumber = recv.serialNumber;
		this.firmwareRevision = recv.firmwareRevision;

		// configuration
		this.name = switches.name || 'Denon Input';
		this.ip = switches.ip;
		this.inputID = switches.inputID;
		this.zone = switches.zone || 1;
		if (this.zone < 1 || this.zone > 3)
			this.zone = 1;

		if (this.zone == 2)
			this.recv.zTwoEn = true;
		if (this.zone == 3)
			this.recv.zThreeEn = true;

		this.iterator = this.zone - 1;
		this.pollAllInput = switches.pollAllInput || false;

		this.level = switches.defaultVolume;
		this.denonLevel;
		if (this.level > 0) {
			if (this.level < 10)
				this.denonLevel = '0' + this.level.toString();
			else
				this.denonLevel = this.level.toString();
		}

		/* setup variables */
		this.switchState = false;

		this.setupLegacyService();
	}

	/*****************************************
	 * Start of legacy service 
	 ****************************************/
	setupLegacyService() {
		if (traceOn)
			logDebug('DEBUG: setupLegacyService zone: ' + this.zone + ': ' + this.name);
			
		/* Delay to wait for retrieve device info */
		this.uuid = UUIDGen.generate(this.name+this.ip+toString(this.zone)+"switch");

		let isCached = this.testCachedAccessories();

		if (!isCached) {
			g_log("New switch configured: " + this.name);

			this.accessory =  new Accessory(this.name, this.uuid);

			this.switchService = new Service.Switch(this.name, 'legacyInput');
			this.switchService
				.getCharacteristic(Characteristic.On)
				.on('get', this.getPowerStateLegacy.bind(this))
				.on('set', this.setPowerStateLegacy.bind(this));

			this.accessory
				.getService(Service.AccessoryInformation)
				.setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
				.setCharacteristic(Characteristic.Model, this.modelName)
				.setCharacteristic(Characteristic.SerialNumber, this.serialNumber)
				.setCharacteristic(Characteristic.FirmwareRevision, this.firmwareRevision);

			this.accessory.addService(this.switchService);

			try {
				this.api.registerPlatformAccessories(pluginName, platformName, [this.accessory]);
			} catch {
				g_log.error("ERROR: Could not register switch with name: %s", this.accessory.context.name);
			}
		} else {
			g_log("Configured switch found: " + this.name);
			this.accessory
				.getService(Service.Switch)
				.getCharacteristic(Characteristic.On)
				.on('get', this.getPowerStateLegacy.bind(this))
				.on('set', this.setPowerStateLegacy.bind(this));

			// this.api.updatePlatformAccessories([this.accessory]);
		}
	}

	setReceiverState(stateInfo) {
		if (this.zone != stateInfo.zone)
			return;

		if (traceOn && setAVRState)
			logDebug('DEBUG: setReceiverState zone: ' + this.zone + ': ' + this.name);

		if ((stateInfo.power === true || stateInfo.power === false) && stateInfo.inputID) {
			if (stateInfo.power && (this.pollAllInput || stateInfo.inputID === this.inputID)) { 
				this.switchState = true;
			} else {
				this.switchState = false;
			}
			if (this.accessory) {
				this.accessory
					.getService(Service.Switch)
					.getCharacteristic(Characteristic.On)
					.updateValue(this.switchState);
			}
		} else if ((stateInfo.power === true || stateInfo.power === false) && !stateInfo.inputID) {
			if (stateInfo.power && this.pollAllInput) { 
				this.switchState = true;
			} else {
				this.switchState = false;
			}
			if (this.accessory) {
				this.accessory
					.getService(Service.Switch)
					.getCharacteristic(Characteristic.On)
					.updateValue(this.switchState);
			}
		}
	}

	getPowerStateLegacy(callback) {
		if (traceOn)
			logDebug('DEBUG: getPowerStateLegacy zone: ' + this.zone + ': ' + this.name);	
		
		let switchState = false;
		if (this.recv.poweredOn[this.iterator] && (this.recv.currentInputID[this.iterator] == this.inputID || this.pollAllInput))
			switchState = true
		
		callback(null, switchState);
	}

	setPowerStateLegacy(state, callback) {
		if (traceOn)
			logDebug('DEBUG: setPowerStateLegacy zone: ' + this.zone + ' state: ' + this.name);

		if (this.recv.htmlControl) {
			this.setPowerStateHTML(state, callback);
		} else {
			this.setPowerStateTelNet(state, callback);
		}
	}

	setPowerStateHTML(state, callback) {
		var stateString = (state ? 'On' : 'Standby');
		var inputString;
		let inputNameN = this.inputID.replace('/', '%2F');
		if (this.zone == 1) {
			inputString = 'SI' + inputNameN;
		} else if (this.zone == 2 || this.zone == 3) {
			inputString = 'Z' + this.zone + inputNameN;
		}
		var that = this;
		if (this.recv.poweredOn[this.iterator] != state) {
			request('http://' + that.ip + ':' + that.legacyPort + '/goform/formiPhoneAppPower.xml?' + that.zone + '+Power' + stateString, function(error, response, body) {
				if(error) {
					g_log.error("ERROR: Can't connect to receiver with ip: %s and port: %s", that.ip, that.legacyPort);
					logDebug('DEBUG: ' + error);
					callback(error);
				} else if (body.indexOf('Error 403: Forbidden') === 0) {
					g_log.error('ERROR: Can not access receiver with IP: %s. Might be due to a wrong port. Try 80 or 8080 manually in config file.', that.ip);
				} else if(state) {
					/* Switch to correct input if switching on and legacy service */
					request('http://' + that.ip + ':' + that.legacyPort + '/goform/formiPhoneAppDirect.xml?' + inputString, function(error, response, body) {
						if(error) {
							g_log.error("ERROR: Can't connect to receiver with ip: %s and port: %s", that.ip, that.legacyPort);
							logDebug('DEBUG: ' + error);
							callback(error);
						} else {

							/* Update possible other switches and accessories too */
							let stateInfo = {
								zone: that.zone,
								power: state,
								inputID: that.inputID,
								masterVol: null,
								mute: null
							}
							that.recv.updateStates(that.recv, stateInfo, that.name);

							that.setDefaultVolume(that);

							callback();
						}
					});
				} else {

					/* Update possible other switches and accessories too */
					let stateInfo = {
						zone: that.zone,
						power: state,
						inputID: that.inputID,
						masterVol: null,
						mute: null
					}
					that.recv.updateStates(that.recv, stateInfo, that.name);

					that.setDefaultVolume(that);

					callback();
				}
			});
		} else {
			request('http://' + that.ip + ':' + that.legacyPort + '/goform/formiPhoneAppDirect.xml?' + inputString, function(error, response, body) {
				if(error) {
					g_log.error("ERROR: Can't connect to receiver with ip: %s and port: %s", that.ip, that.legacyPort);
					logDebug('DEBUG: ' + error);
					callback(error);
				} else {
					/* Update possible other switches and accessories too */
					let stateInfo = {
						zone: that.zone,
						power: state,
						inputID: that.inputID,
						masterVol: null,
						mute: null
					}
					that.recv.updateStates(that.recv, stateInfo, that.name);

					that.setDefaultVolume(that);

					callback();
				}
			});
		}
	}

	setPowerStateTelNet(state, callback) {
		var stateString;
		var inputString;
		let inputName = this.inputID;
		inputName = inputName.replace('/', '%2F');

		if (this.zone == 1) {
			inputString = 'SI' + inputName;
			stateString = 'PW' + (state ? 'ON' : 'STANDBY');
		} else if (this.zone == 2 || this.zone == 3) {
			inputString = 'Z' + this.zone + inputName;
			stateString = 'Z' + this.zone + (state ? 'ON' : 'OFF');
		}
		
		var that = this;
		if (this.recv.poweredOn[this.iterator] != state) {
			that.recv.telnetConnection.send(stateString);
			/* Update possible other switches and accessories too */
			if(state) {
				/* Switch to correct input if switching on and legacy service */
				that.recv.telnetConnection.send(inputString);
				/* Update possible other switches and accessories too */
				let stateInfo = {
					zone: that.zone,
					power: state,
					inputID: that.inputID,
					masterVol: null,
					mute: null
				}
				that.recv.updateStates(that.recv, stateInfo, that.name);

				that.setDefaultVolume(that);

				callback();

			} else {
				/* Update possible other switches and accessories too */
				let stateInfo = {
					zone: that.zone,
					power: state,
					inputID: that.inputID,
					masterVol: null,
					mute: null
				}
				that.recv.updateStates(that.recv, stateInfo, that.name);

				that.setDefaultVolume(that);

				callback();
			}
		} else {
			that.recv.telnetConnection.send(inputString);
			/* Update possible other switches and accessories too */
			let stateInfo = {
				zone: that.zone,
				power: state,
				inputID: that.inputID,
				masterVol: null,
				mute: null
			}
			that.recv.updateStates(that.recv, stateInfo, that.name);

			that.setDefaultVolume(that);

			callback();
		}
	}

	setDefaultVolume(that) {
		var volumeString;
		if (this.zone == 1)
			volumeString = 'MV';
		else if (this.zone == 2 || this.zone == 3)
			volumeString = 'Z' + this.zone;
			
		/* Set default volume if this is set */
		if (that.recv.htmlControl) {
			setTimeout(function(){
				request('http://' + that.ip + ':' + that.legacyPort + '/goform/formiPhoneAppDirect.xml?' + volumeString + that.denonLevel, function(error, response, body) {
					if(error) {
						g_log.error("ERROR: Can't connect to receiver with ip: %s and port: %s", that.ip, that.legacyPort);
						logDebug('DEBUG: ' + error);
						callback(error);
					} else {
						/* Update possible other switches and accessories too */
						let stateInfo = {
							zone: that.zone,
							power: null,
							inputID: null,
							masterVol: that.level,
							mute: null
						}
						that.recv.updateStates(that.recv, stateInfo, that.name);
					}
				});
			}, 2000);
		} else {		
			if (that.level > 0) {
				setTimeout(function(){
					that.recv.telnetConnection.send(volumeString + that.denonLevel);

					/* Update possible other switches and accessories too */
					let stateInfo = {
						zone: that.zone,
						power: null,
						inputID: null,
						masterVol: that.level,
						mute: null
					}
					that.recv.updateStates(that.recv, stateInfo, that.name);
				}, 2000);
			}
		}
	}

	testCachedAccessories() {
		this.accessory = cachedAccessories.find(cachedAccessories => cachedAccessories.UUID === this.uuid);
		if (this.accessory) {
			cachedAccessories.splice(cachedAccessories.indexOf(this.accessory),1);
			return true;
		}
		return false;
	}

	getName() {
		return this.name;
	}
	/*****************************************
	 * End of legacy service 
	 ****************************************/
}


class volumeClient {
	constructor(recv, volumeControl) {
		this.port = 3000;
		this.api = recv.api;
		this.recv = recv;

		this.volumePort = recv.webAPIPort;

		this.manufacturer = recv.manufacturer;
		this.modelName = recv.modelName;
		this.serialNumber = recv.serialNumber;
		this.firmwareRevision = recv.firmwareRevision;

		// configuration
		this.name = volumeControl.name || 'Denon Input';
		this.ip = volumeControl.ip;
		this.zone = volumeControl.zone || 1;
		if (this.zone < 1 || this.zone > 3)
			this.zone = 1;

		if (this.zone == 2)
			this.recv.zTwoEn = true;
		if (this.zone == 3)
			this.recv.zThreeEn = true;

		this.iterator = this.zone - 1;

		this.volumeLimit = volumeControl.volumeLimit || 100;
		if (typeof this.volumeLimit != 'number' || isFinite(this.volumeLimit))
			this.volumeLimit = parseInt(this.volumeLimit);
		if (this.volumeLimit < 0 || this.volumeLimit > 100)
			this.volumeLimit = 100;

		this.controlType = volumeControl.controlType || 'bulb';
		this.controlType.toLowerCase();

		this.setupVolumeService();
	}

	/*****************************************
	 * Start of volume service 
	 ****************************************/
	setupVolumeService() {
		if (traceOn)
			logDebug('DEBUG: setupVolumeService zone: ' + this.zone + ': ' + this.name);
			
		/* Delay to wait for retrieve device info */
		this.uuid = UUIDGen.generate(this.name+this.controlType+"volumeControl");
		let isCached = this.testCachedAccessories();

		if (!isCached) {
			this.accessory =  new Accessory(this.name, this.uuid);

			g_log("New volumeControl configured: " + this.name);
			if (this.controlType === 'bulb'){
				this.volumeService = new Service.Lightbulb(this.name, 'volumeInput');
				this.volumeService
					.getCharacteristic(Characteristic.On)
					.on('get', this.getMuteState.bind(this))
					.on('set', this.setMuteState.bind(this));
				this.volumeService
					.getCharacteristic(Characteristic.Brightness)
					.on('get', this.getVolume.bind(this))
					.on('set', this.setVolume.bind(this));
			} else if (this.controlType === 'fan') {
				this.volumeService = new Service.Fanv2(this.name, 'volumeInput');
				this.volumeService
					.getCharacteristic(Characteristic.Active)
					.on('get', this.getMuteState.bind(this))
					.on('set', this.setMuteState.bind(this));
				this.volumeService
					.getCharacteristic(Characteristic.RotationSpeed)
					.on('get', this.getVolume.bind(this))
					.on('set', this.setVolume.bind(this));
			} else if (this.controlType === 'speaker') {
				this.accessory.category = this.api.hap.Categories.SPEAKER;
				this.volumeService = new Service.Speaker(this.name, 'volumeInput');
				this.volumeService
					.getCharacteristic(Characteristic.Mute)
					.on('get', this.getMuteState.bind(this))
					.on('set', this.setMuteState.bind(this));
				this.volumeService
					.getCharacteristic(Characteristic.Volume)
					.on('get', this.getVolume.bind(this))
					.on('set', this.setVolume.bind(this));
			} else if (this.controlType === 'smartspeaker') {
				this.accessory.category = this.api.hap.Categories.SPEAKER;
				this.volumeService = new Service.SmartSpeaker(this.name, 'volumeInput');
				this.volumeService
					.setCharacteristic(Characteristic.ConfiguredName, this.name);
				this.volumeService
					.getCharacteristic(Characteristic.CurrentMediaState)
					.on('set', this.setMedia.bind(this));
				this.volumeService
					.getCharacteristic(Characteristic.TargetMediaState)
					.on('set', this.setMedia.bind(this));
				this.volumeService
					.getCharacteristic(Characteristic.Volume)
					.on('get', this.getVolume.bind(this))
					.on('set', this.setVolume.bind(this));
				this.volumeService
					.setCharacteristic(Characteristic.CurrentMediaState, Characteristic.CurrentMediaState.STOP);
				this.volumeService
					.setCharacteristic(Characteristic.TargetMediaState, Characteristic.CurrentMediaState.STOP);
			}


			this.accessory
				.getService(Service.AccessoryInformation)
				.setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
				.setCharacteristic(Characteristic.Model, this.modelName)
				.setCharacteristic(Characteristic.SerialNumber, this.serialNumber)
				.setCharacteristic(Characteristic.FirmwareRevision, this.firmwareRevision);

			this.accessory.addService(this.volumeService);

			try {
				this.api.registerPlatformAccessories(pluginName, platformName, [this.accessory]);
			} catch {
				g_log.error("ERROR: Could not register volume control with name: %s", this.accessory.context.name);
			}
		} else {
			g_log("Configured volumeControl found: " + this.name);
			if (this.controlType === 'bulb') {
				this.accessory
					.getService(Service.Lightbulb)
					.getCharacteristic(Characteristic.On)
					.on('get', this.getMuteState.bind(this))
					.on('set', this.setMuteState.bind(this));
				this.accessory
					.getService(Service.Lightbulb)
					.getCharacteristic(Characteristic.Brightness)
					.on('get', this.getVolume.bind(this))
					.on('set', this.setVolume.bind(this));
			} else if (this.controlType === 'fan') {
				this.accessory
					.getService(Service.Fanv2)
					.getCharacteristic(Characteristic.Active)
					.on('get', this.getMuteState.bind(this))
					.on('set', this.setMuteState.bind(this));
				this.accessory
					.getService(Service.Fanv2)
					.getCharacteristic(Characteristic.RotationSpeed)
					.on('get', this.getVolume.bind(this))
					.on('set', this.setVolume.bind(this));
			} else if (this.controlType === 'speaker') {
				this.accessory
					.getService(Service.Speaker)
					.getCharacteristic(Characteristic.Mute)
					.on('get', this.getMuteState.bind(this))
					.on('set', this.setMuteState.bind(this));
				this.accessory
					.getService(Service.Speaker)
					.getCharacteristic(Characteristic.Volume)
					.on('get', this.getVolume.bind(this))
					.on('set', this.setVolume.bind(this));
			} else if (this.controlType === 'smartspeaker') {
				this.accessory
					.getService(Service.SmartSpeaker)
					.getCharacteristic(Characteristic.CurrentMediaState)
					.on('set', this.setMedia.bind(this));
				this.accessory
					.getService(Service.SmartSpeaker)
					.getCharacteristic(Characteristic.TargetMediaState)
					.on('set', this.setMedia.bind(this));
				this.accessory
					.getService(Service.SmartSpeaker)
					.getCharacteristic(Characteristic.Volume)
					.on('get', this.getVolume.bind(this))
					.on('set', this.setVolume.bind(this));
				this.accessory
					.getService(Service.SmartSpeaker)
					.updateCharacteristic(Characteristic.CurrentMediaState, Characteristic.CurrentMediaState.STOP);
				this.accessory
					.getService(Service.SmartSpeaker)
					.updateCharacteristic(Characteristic.TargetMediaState, Characteristic.CurrentMediaState.STOP);
			}
			 this.api.updatePlatformAccessories([this.accessory]);
		}
	}

	setReceiverState(stateInfo) {
		if (this.zone != stateInfo.zone)
			return;

		if (traceOn && setAVRState)
			logDebug('DEBUG: setReceiverState zone: ' + this.zone + ': ' + this.name);
		if (this.controlType === 'bulb') {
			if (stateInfo.masterVol) {
				this.accessory
						.getService(Service.Lightbulb)
						.getCharacteristic(Characteristic.Brightness)
						.updateValue(this.recv.volumeLevel[this.iterator]);
			}
			if ((stateInfo.mute === true || stateInfo.mute === false) && this.recv.poweredOn[this.iterator]) {
				this.accessory
						.getService(Service.Lightbulb)
						.getCharacteristic(Characteristic.On)
						.updateValue(!this.recv.muteState[this.iterator]);
			} else if (!this.recv.poweredOn[this.iterator]) {
				this.accessory
						.getService(Service.Lightbulb)
						.getCharacteristic(Characteristic.On)
						.updateValue(false);
			}
		} else if (this.controlType === 'fan') {
			if (stateInfo.masterVol) {
				this.accessory
						.getService(Service.Fanv2)
						.getCharacteristic(Characteristic.RotationSpeed)
						.updateValue(this.recv.volumeLevel[this.iterator]);
			}
			if ((stateInfo.mute === true || stateInfo.mute === false) && this.recv.poweredOn[this.iterator]) {
				this.accessory
						.getService(Service.Fanv2)
						.getCharacteristic(Characteristic.Active)
						.updateValue(!this.recv.muteState[this.iterator]);
			} else if (!this.recv.poweredOn[this.iterator]) {
				this.accessory
						.getService(Service.Fanv2)
						.getCharacteristic(Characteristic.Active)
						.updateValue(false);
			}
		} else if (this.controlType === 'speaker') {
			if (stateInfo.masterVol) {
				this.accessory
					.getService(Service.Speaker)
					.updateCharacteristic(Characteristic.Volume, this.recv.volumeLevel[this.iterator]);
			}
			if ((stateInfo.mute === true || stateInfo.mute === false) && this.recv.poweredOn[this.iterator]) {
				this.accessory
					.getService(Service.Speaker)
					.updateCharacteristic(Characteristic.Mute, this.recv.muteState[this.iterator]);
			} 
		} else if (this.controlType === 'smartspeaker') {
			if (stateInfo.masterVol) {
				this.accessory
					.getService(Service.SmartSpeaker)
					.updateCharacteristic(Characteristic.Volume, this.recv.volumeLevel[this.iterator]);
			}
		}
	}

	getMuteState(callback) {
		if (traceOn)
			logDebug('DEBUG: getMuteState: ' + this.name);

		let state = !this.recv.muteState[this.iterator]
		if (this.controlType === 'bulb' || this.controlType === 'fan')
			state = !state;
			
		if (this.recv.poweredOn[this.iterator]) {
			callback(null, state);
		} else {
			callback(null, false);
		}
	}

	setMuteState(state, callback) {
		if (traceOn)
			logDebug('DEBUG: setMuteState zone: ' + this.zone + ': ' + this.name);

		if (this.controlType === 'bulb' || this.controlType === 'fan')
			state = !state;

		var stateString;
		if (this.zone == 1)
			stateString = (state ? 'MUON' : 'MUOFF');
		else if (this.zone == 2 || this.zone == 3)
			stateString = 'Z' + this.zone + 'MU' + (state ? 'ON' : 'OFF');

		var that = this;

		if (this.recv.htmlControl) {
			request('http://' + this.ip + ':' + this.volumePort + '/goform/formiPhoneAppDirect.xml?' + stateString, function(error, response, body) {
				if(error) {
					g_log.error("ERROR: Can't connect to receiver with ip: %s and port: %s", that.ip, that.volumePort);
					logDebug('DEBUG: ' + error);
					callback(error);
				} else if (body.indexOf('Error 403: Forbidden') === 0) {
					g_log.error('ERROR: Can not access receiver with IP: %s. Might be due to a wrong port. Try 80 or 8080 manually in config file.', that.ip);
				} else {
					let stateInfo = {
						zone: that.zone,
						power: null,
						inputID: null,
						masterVol: null,
						mute: state
					}
					that.recv.updateStates(that.recv, stateInfo, that.name);

					callback();
				}
			});
		} else {
			that.recv.telnetConnection.send(stateString);
			/* Update possible other switches and accessories too */
			let stateInfo = {
				zone: that.zone,
				power: null,
				inputID: null,
				masterVol: null,
				mute: state
			}
			that.recv.updateStates(that.recv, stateInfo, that.name);

			callback();
		}
	}

	setMedia(state, callback) {
		this.volumeService
		  .updateCharacteristic(Characteristic.TargetMediaState, state);
		this.volumeService
		  .updateCharacteristic(Characteristic.CurrentMediaState, state);
		callback(null);
	}

	getVolume(callback) {
		if (traceOn)
			logDebug('DEBUG: getVolume zone: ' + this.zone + ': ' + this.name);

		if (this.recv.poweredOn[this.iterator]) {
			callback(null, this.recv.volumeLevel[this.iterator]);
		} else {
			callback(null, 0);
		}
	}

	setVolume(level, callback) {
		if (level > this.volumeLimit)
			level = this.volumeLimit;
		
		if (traceOn)
			logDebug('DEBUG: setVolume: ' + this.name + ' to :' + level);

		this.recv.volumeLevel[this.iterator] = level;
		
		var that = this;
		var denonLevel;
		if (level < 10)
			denonLevel = '0' + level.toString();
		else
			denonLevel = level.toString();

		var zoneSettings;
		if (this.zone == 1)
			zoneSettings = 'MV';
		else if (this.zone == 2 || this.zone == 3)
			zoneSettings = 'Z' + this.zone;

		if (this.recv.htmlControl) {
			request('http://' + that.ip + ':' + this.volumePort + '/goform/formiPhoneAppDirect.xml?' + zoneSettings + denonLevel, function(error, response, body) {
				if(error) {
					g_log.error("ERROR: Can't connect to receiver with ip: %s and port: %s", that.ip, that.volumePort);
					logDebug('DEBUG: ' + error);
					callback(error);
				} else if (body.indexOf('Error 403: Forbidden') === 0) {
					g_log.error('ERROR: Can not access receiver with IP: %s. Might be due to a wrong port. Try 80 or 8080 manually in config file.', that.ip);
				} else {
					/* Update possible other switches and accessories too */
					let stateInfo = {
						zone: that.zone,
						power: null,
						inputID: null,
						masterVol: level,
						mute: null
					}
					that.recv.updateStates(that.recv, stateInfo, that.name);

					callback();
				}
			});
		} else {
			that.recv.telnetConnection.send(zoneSettings + denonLevel);
			/* Update possible other switches and accessories too */
			let stateInfo = {
				zone: that.zone,
				power: null,
				inputID: null,
				masterVol: level,
				mute: null
			}
			that.recv.updateStates(that.recv, stateInfo, that.name);

			callback();
		}
	}

	testCachedAccessories() {
		this.accessory = cachedAccessories.find(cachedAccessories => cachedAccessories.UUID === this.uuid);
		if (this.accessory) {
			cachedAccessories.splice(cachedAccessories.indexOf(this.accessory),1);
			return true;
		}
		return false;
	}

	getName() {
		return this.name;
	}

	/*****************************************
	 * Volume service 
	 ****************************************/
}



