#!/usr/bin/env node

var pkg = require('./package.json');
var config = require('./config.js');
var log = require('yalm');
log.setLevel(config.verbosity);

log(pkg.name + ' ' + pkg.version + ' starting');
var Mqtt = require('mqtt');

log.info('loading HomeKit to MQTT mapping file ' + config.mapfile);
var mapping = require(config.mapfile);


var mqttStatus = {};
var mqttCallbacks = {};

var mqttConnected;

log.info('mqtt trying to connect', config.url);
var mqtt = Mqtt.connect(config.url, {will: {topic: config.name + '/connected', payload: '0', retain: true}});

mqtt.on('connect', function () {
    mqttConnected = true;
    log.info('mqtt connected ' + config.url);
    mqtt.publish(config.name + '/connected', '2', {retain: true});
    //log.info('mqtt subscribe', config.name + '/set/#');
    //mqtt.subscribe(config.name + '/set/#');
});

mqtt.on('close', function () {
    if (mqttConnected) {
        mqttConnected = false;
        log.info('mqtt closed ' + config.url);
    }
});

mqtt.on('error', function () {
    log.error('mqtt error ' + config.url);
});

mqtt.on('message', function (topic, payload) {
    payload = payload.toString();
    var state;
    try {
        // todo - check for json objects in a less nasty way ;)
        if (payload.indexOf('{') === -1) throw 'not an object';
        state = JSON.parse(payload).val;
    } catch (e) {
        if (payload === 'true') {
            state = true;
        } else if (payload === 'false') {
            state = false;
        } else if (!isNaN(payload)) {
            state = parseFloat(payload);
        } else {
            state = payload;
        }
    }
    log.debug('< mqtt', topic, state);
    mqttStatus[topic] = state;
    if (mqttCallbacks[topic]) {
        mqttCallbacks[topic].forEach(function (cb) {
            cb(state);
        });
    }
});

// MQTT subscribe function that provides a callback on incoming messages.
// Not meant to be used with wildcards!
function mqttSub(topic, callback) {
    if (typeof callback === 'function') {
        if (!mqttCallbacks[topic]) {
            mqttCallbacks[topic] = [callback];
            log.debug('mqtt subscribe', topic);
            mqtt.subscribe(topic);
        } else {
            mqttCallbacks[topic].push(callback);
        }
    } else {
        log.debug('mqtt subscribe', topic);
        mqtt.subscribe(topic);
    }
}

function mqttPub(topic, payload, options) {
    if (typeof payload === 'object') {
        payload = JSON.stringify(payload);
    } else if (typeof payload !== 'string') {
        payload = '' + payload;
    }
    mqtt.publish(topic, payload, options);
}

var pkgHap =            require('./node_modules/hap-nodejs/package.json');
log.info('using hap-nodejs version', pkgHap.version);

var HAP =               require('hap-nodejs');
var uuid =              HAP.uuid;
var Bridge =            HAP.Bridge;
var Accessory =         HAP.Accessory;
var Service =           HAP.Service;
var Characteristic =    HAP.Characteristic;

if (config.storagedir) {
    log.info('using directory ' + config.storagedir + ' for persistent storage');
}
HAP.init(config.storagedir || undefined);

// Create Bridge which will host all Accessories
var bridge = new Bridge(config.bridgename, uuid.generate(config.bridgename));

// Listen for Bridge identification event
bridge.on('identify', function (paired, callback) {
    log('< hap bridge identify', paired ? '(paired)' : '(unpaired)');
    callback();
});

// Handler for Accessory identification events
function identify(settings, paired, callback) {
    log.debug('< hap identify', settings.name, paired ? '(paired)' : '(unpaired)');
    if (settings.topic.identify) {
        log.debug('> mqtt', settings.topic.identify, settings.payload.identify);
        mqttPub(settings.topic.identify, settings.payload.identify);
    }
    callback();
}

function newAccessory(settings) {
    var acc = new Accessory(settings.name, uuid.generate(settings.id));
    if (settings.manufacturer || settings.model || settings.serial) {
        acc.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, settings.manufacturer || "-")
            .setCharacteristic(Characteristic.Model, settings.model || "-" )
            .setCharacteristic(Characteristic.SerialNumber, settings.serial || "-");
    }
    acc.on('identify', function (paired, callback) {
        identify(settings, paired, callback);
    });
    return acc;
}

var createAccessory = {
    CarbonDioxideSensor: function createAccessory_CarbonDioxideSensor(settings) {

        var sensor = newAccessory(settings);

        sensor.addService(Service.CarbonDioxideSensor, settings.name)
            .getCharacteristic(Characteristic.CarbonDioxideDetected)
            .on('get', function (callback) {
                log.debug('< hap get', settings.name, 'CarbonDioxideDetected');
                var contact = mqttStatus[settings.topic.statusCarbonDioxideDetected] === settings.payload.onCarbonDioxideDetected
                    ? Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
                    : Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL;

                log.debug('> hap re_get', settings.name, 'CarbonDioxideDetected', contact);
                callback(null, contact);
            });

        mqttSub(settings.topic.statusCarbonDioxideDetected, function (val) {
            var contact = val === settings.payload.onCarbonDioxideDetected
                ? Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
                : Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL;
            log.debug('> hap set', settings.name, 'CarbonDioxideDetected', contact);
            sensor.getService(Service.CarbonDioxideSensor)
                .setCharacteristic(Characteristic.CarbonDioxideDetected, contact)
        });

        if (settings.topic.statusLowBattery) {
            sensor.getService(Service.CarbonDioxideSensor, settings.name)
                .getCharacteristic(Characteristic.StatusLowBattery)
                .on('get', function (callback) {
                    log.debug('< hap get', settings.name, 'StatusLowBattery');
                    var bat = mqttStatus[settings.topic.statusLowBattery] === settings.payload.onLowBattery
                        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
                    log.debug('> hap re_get', settings.name, 'StatusLowBattery', bat);
                    callback(null, bat);
                });

            mqttSub(settings.topic.statusLowBattery, function (val) {
                var bat = val === settings.payload.onLowBattery
                    ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                    : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
                log.debug('> hap set', settings.name, 'StatusLowBattery', bat);
                sensor.getService(Service.CarbonDioxideSensor)
                    .setCharacteristic(Characteristic.StatusLowBattery, bat)
            });
        }

        return sensor;

    },
    CarbonMonoxideSensor: function createAccessory_CarbonMonoxideSensor(settings) {

        var sensor = newAccessory(settings);

        sensor.addService(Service.CarbonMonoxideSensor, settings.name)
            .getCharacteristic(Characteristic.CarbonMonoxideDetected)
            .on('get', function (callback) {
                log.debug('< hap get', settings.name, 'CarbonMonoxideDetected');
                var contact = mqttStatus[settings.topic.statusCarbonMonoxideDetected] === settings.payload.onCarbonMonoxideDetected
                    ? Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
                    : Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;

                log.debug('> hap re_get', settings.name, 'CarbonMonoxideDetected', contact);
                callback(null, contact);
            });

        mqttSub(settings.topic.statusCarbonMonoxideDetected, function (val) {
            var contact = val === settings.payload.onCarbonMonoxideDetected
                ? Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
                : Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;
            log.debug('> hap set', settings.name, 'CarbonMonoxideDetected', contact);
            sensor.getService(Service.CarbonMonoxideSensor)
                .setCharacteristic(Characteristic.CarbonMonoxideDetected, contact)
        });

        if (settings.topic.statusLowBattery) {
            sensor.getService(Service.CarbonMonoxideSensor, settings.name)
                .getCharacteristic(Characteristic.StatusLowBattery)
                .on('get', function (callback) {
                    log.debug('< hap get', settings.name, 'StatusLowBattery');
                    var bat = mqttStatus[settings.topic.statusLowBattery] === settings.payload.onLowBattery
                        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
                    log.debug('> hap re_get', settings.name, 'StatusLowBattery', bat);
                    callback(null, bat);
                });

            mqttSub(settings.topic.statusLowBattery, function (val) {
                var bat = val === settings.payload.onLowBattery
                    ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                    : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
                log.debug('> hap set', settings.name, 'StatusLowBattery', bat);
                sensor.getService(Service.CarbonMonoxideSensor)
                    .setCharacteristic(Characteristic.StatusLowBattery, bat)
            });
        }

        return sensor;

    },
    ContactSensor: function createAccessory_ContactSensor(settings) {

        var sensor = newAccessory(settings);

        sensor.addService(Service.ContactSensor, settings.name)
            .getCharacteristic(Characteristic.ContactSensorState)
            .on('get', function (callback) {
                log.debug('< hap get', settings.name, 'ContactSensorState');
                var contact = mqttStatus[settings.topic.statusContactSensorState] === settings.payload.onContactDetected
                    ? Characteristic.ContactSensorState.CONTACT_DETECTED
                    : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;

                log.debug('> hap re_get', settings.name, 'ContactSensorState', contact);
                callback(null, contact);
            });

        mqttSub(settings.topic.statusContactSensorState, function (val) {
            var contact = val === settings.payload.onContactDetected
                ? Characteristic.ContactSensorState.CONTACT_DETECTED
                : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
            log.debug('> hap set', settings.name, 'ContactSensorState', contact);
            sensor.getService(Service.ContactSensor)
                .setCharacteristic(Characteristic.ContactSensorState, contact)
        });

        if (settings.topic.statusLowBattery) {
            sensor.getService(Service.ContactSensor, settings.name)
                .getCharacteristic(Characteristic.StatusLowBattery)
                .on('get', function (callback) {
                    log.debug('< hap get', settings.name, 'StatusLowBattery');
                    var bat = mqttStatus[settings.topic.statusLowBattery] === settings.payload.onLowBattery
                        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
                    log.debug('> hap re_get', settings.name, 'StatusLowBattery', bat);
                    callback(null, bat);
                });

            mqttSub(settings.topic.statusLowBattery, function (val) {
                var bat = val === settings.payload.onLowBattery
                    ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                    : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
                log.debug('> hap set', settings.name, 'StatusLowBattery', bat);
                sensor.getService(Service.ContactSensor)
                    .setCharacteristic(Characteristic.StatusLowBattery, bat)
            });
        }

        return sensor;

    },
    Doorbell: function createAccessory_Doorbell (settings) {
        var sw = newAccessory(settings);

        sw.addService(Service.Doorbell, settings.name);

        mqttSub(settings.topic.statusEvent, function () {
            log.debug('> hap set', settings.name, 'ProgrammableSwitchEvent', 1);
            sw.getService(Service.Doorbell)
                .setCharacteristic(Characteristic.ProgrammableSwitchEvent, 1)
        });


        return sw;
    },
    GarageDoorOpener: function createAccessory_GarageDoorOpener(settings) {
        /* Required Characteristics
        this.addCharacteristic(Characteristic.CurrentDoorState);
        this.addCharacteristic(Characteristic.TargetDoorState);
        this.addCharacteristic(Characteristic.ObstructionDetected);

        // Optional Characteristics
        this.addOptionalCharacteristic(Characteristic.LockCurrentState);
        this.addOptionalCharacteristic(Characteristic.LockTargetState);
        this.addOptionalCharacteristic(Characteristic.Name);*/

        var garage = newAccessory(settings);
        garage.addService(Service.GarageDoorOpener, settings.name)
            .getCharacteristic(Characteristic.TargetDoorState)
            .on('set', function (value, callback) {
                log.debug('< hap set', settings.name, 'TargetDoorState', value);
                if (value == Characteristic.TargetDoorState.OPEN) {
                    log.debug('> mqtt publish', settings.topic.setDoor, settings.payload.doorOpen);
                    mqttPub(settings.topic.setLock, settings.payload.doorOpen);

                    callback();
                } else if (value == Characteristic.TargetDoorState.CLOSED) {
                    log.debug('> mqtt publish', settings.topic.setDoor, settings.payload.doorClosed);
                    mqttPub(settings.topic.setLock, settings.payload.doorClosed);

                    callback();
                }
            });

        if (settings.topic.statusDoor) {
            var initial = true;
            
            /* TODO opening/closing/stopped
             Characteristic.CurrentDoorState.OPEN = 0;
             Characteristic.CurrentDoorState.CLOSED = 1;
             Characteristic.CurrentDoorState.OPENING = 2;
             Characteristic.CurrentDoorState.CLOSING = 3;
             Characteristic.CurrentDoorState.STOPPED = 4;
            */

            mqttSub(settings.topic.statusDoor, function (val) {
                if (val === settings.payload.doorClosed) {
                    log.debug('> hap set', settings.name, 'CurrentDoorState.CLOSED');
                    garage.getService(Service.GarageDoorOpener)
                        .setCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.CLOSED);
                    if (initial) {
                        log.debug('> hap set', settings.name, 'CurrentDoorState.CLOSED');
                        garage.getService(Service.GarageDoorOpener)
                            .setCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.CLOSED);
                        initial = false;
                    }
                } else {
                    log.debug('> hap set', settings.name, 'CurrentDoorState.OPEN');
                    garage.getService(Service.GarageDoorOpener)
                        .setCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.OPEN);
                    if (initial) {
                        log.debug('> hap set', settings.name, 'CurrentDoorState.OPEN');
                        garage.getService(Service.GarageDoorOpener)
                            .setCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.OPEN);
                        initial = false;
                    }
                }
            });

            garage.getService(Service.GarageDoorOpener)
                .getCharacteristic(Characteristic.CurrentDoorState)
                .on('get', function(callback) {
                    log.debug('< hap get', settings.name, 'CurrentDoorState');

                    if (mqttStatus[settings.topic.statusDoor] === settings.payload.doorClosed) {
                        log.debug('> hap re_get', settings.name, 'CurrentDoorState.CLOSED');
                        callback(null, Characteristic.CurrentDoorState.SECURED);
                    } else {
                        log.debug('> hap re_get', settings.name, 'CurrentDoorState.OPEN');
                        callback(null, Characteristic.CurrentDoorState.UNSECURED);
                    }
                });
        }

        garage.getService(Service.GarageDoorOpener, settings.name)
            .getCharacteristic(Characteristic.ObstructionDetected)
            .on('get', function (callback) {
                log.debug('< hap get', settings.name, 'ObstructionDetected');
                var obstruction = mqttStatus[settings.topic.statusObstruction] === settings.payload.onObstructionDetected;
                log.debug('> hap re_get', settings.name, 'ObstructionDetected', obstruction);
                callback(null, obstruction);
            });

        if (settings.topic.statusObstruction) {
            mqttSub(settings.topic.statusObstruction, function (val) {
                var obstruction = val === settings.payload.onObstructionDetected;
                log.debug('> hap set', settings.name, 'ObstructionDetected', obstruction);
                garage.getService(Service.GarageDoorOpener)
                    .setCharacteristic(Characteristic.ObstructionDetected, obstruction)
            });
        }

        if (settings.topic.setLock) {
            garage.getService(Service.GarageDoorOpener, settings.name)
                .getCharacteristic(Characteristic.LockTargetState)
                .on('set', function(value, callback) {
                    log.debug('< hap set', settings.name, 'LockTargetState', value);
                    if (value == Characteristic.LockTargetState.UNSECURED) {
                        log.debug('> mqtt publish', settings.topic.setLock, settings.payload.lockUnsecured);
                        mqttPub(settings.topic.setLock, settings.payload.lockUnsecured);
                        callback();
                    } else if (value == Characteristic.LockTargetState.SECURED) {
                        log.debug('> mqtt publish', settings.topic.setLock, settings.payload.lockSecured);
                        mqttPub(settings.topic.setLock, settings.payload.lockSecured);
                        callback();
                    }
                });
        }

        if (settings.topic.statusLock) {

            var initialLock = true;

            mqttSub(settings.topic.statusLock, function (val) {
                if (val === settings.payload.lockSecured) {
                    log.debug('> hap set', settings.name, 'LockCurrentState.SECURED');
                    garage.getService(Service.LockMechanism)
                        .setCharacteristic(Characteristic.LockCurrentState, Characteristic.LockCurrentState.SECURED);
                    if (initialLock) {
                        log.debug('> hap set', settings.name, 'LockTargetState.SECURED');
                        garage.getService(Service.LockMechanism)
                            .setCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.SECURED);
                        initialLock = false;
                    }
                } else {
                    log.debug('> hap set', settings.name, 'LockCurrentState.UNSECURED');
                    garage.getService(Service.LockMechanism)
                        .setCharacteristic(Characteristic.LockCurrentState, Characteristic.LockCurrentState.UNSECURED);
                    if (initialLock) {
                        log.debug('> hap set', settings.name, 'LockTargetState.UNSECURED');
                        garage.getService(Service.LockMechanism)
                            .setCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.UNSECURED);
                        initialLock = false;
                    }
                }
            });


            garage.getService(Service.GarageDoorOpener)
                .getCharacteristic(Characteristic.LockCurrentState)
                .on('get', function (callback) {
                    log.debug('< hap get', settings.name, 'LockCurrentState');

                    if (mqttStatus[settings.topic.statusLock] === settings.payload.lockSecured) {
                        log.debug('> hap re_get', settings.name, 'LockCurrentState.SECURED');
                        callback(null, Characteristic.LockCurrentState.SECURED);
                    } else {
                        log.debug('> hap re_get', settings.name, 'LockCurrentState.UNSECURED');
                        callback(null, Characteristic.LockCurrentState.UNSECURED);
                    }
                });
        }

        return garage;

    },
    HumiditySensor: function createAccessory_HumiditySensor(settings) {

        var sensor = newAccessory(settings);

        mqttSub(settings.topic.statusHumidity, function (val) {
            log.debug('> hap set', settings.name, 'CurrentRelativeHumidity', mqttStatus[settings.topic.statusHumidity]);
            sensor.getService(Service.HumiditySensor)
                .setCharacteristic(Characteristic.CurrentRelativeHumidity, val);
        });

        sensor.addService(Service.HumiditySensor)
            .getCharacteristic(Characteristic.CurrentRelativeHumidity)
            .on('get', function(callback) {
                log.debug('< hap get', settings.name, 'HumiditySensor', 'CurrentRelativeHumidity');
                log.debug('> hap re_get', settings.name, mqttStatus[settings.topic.statusHumidity]);
                callback(null, mqttStatus[settings.topic.statusHumidity]);
            });

        return sensor;
    },
    LeakSensor: function createAccessory_LeakSensor(settings) {

        var sensor = newAccessory(settings);

        sensor.addService(Service.LeakSensor, settings.name)
            .getCharacteristic(Characteristic.LeakDetected)
            .on('get', function (callback) {
                log.debug('< hap get', settings.name, 'LeakDetected');
                var contact = mqttStatus[settings.topic.statusLeakDetected] === settings.payload.onLeakDetected
                    ? Characteristic.LeakDetected.LEAK_DETECTED
                    : Characteristic.LeakDetected.LEAK_NOT_DETECTED;

                log.debug('> hap re_get', settings.name, 'LeakDetected', contact);
                callback(null, contact);
            });

        mqttSub(settings.topic.statusLeakDetected, function (val) {
            var contact = val === settings.payload.onLeakDetected
                ? Characteristic.LeakDetected.LEAK_DETECTED
                : Characteristic.LeakDetected.LEAK_NOT_DETECTED;
            log.debug('> hap set', settings.name, 'LeakDetected', contact);
            sensor.getService(Service.LeakSensor)
                .setCharacteristic(Characteristic.LeakDetected, contact)
        });

        if (settings.topic.statusLowBattery) {
            sensor.getService(Service.LeakSensor, settings.name)
                .getCharacteristic(Characteristic.StatusLowBattery)
                .on('get', function (callback) {
                    log.debug('< hap get', settings.name, 'StatusLowBattery');
                    var bat = mqttStatus[settings.topic.statusLowBattery] === settings.payload.onLowBattery
                        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
                    log.debug('> hap re_get', settings.name, 'StatusLowBattery', bat);
                    callback(null, bat);
                });

            mqttSub(settings.topic.statusLowBattery, function (val) {
                var bat = val === settings.payload.onLowBattery
                    ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                    : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
                log.debug('> hap set', settings.name, 'StatusLowBattery', bat);
                sensor.getService(Service.LeakSensor)
                    .setCharacteristic(Characteristic.StatusLowBattery, bat)
            });
        }

        return sensor;

    },
    Lightbulb: function createAccessory_Lightbulb(settings) {

        var light = newAccessory(settings);

        light.addService(Service.Lightbulb, settings.name)
            .getCharacteristic(Characteristic.On)
            .on('set', function (value, callback) {
                log.debug('< hap set', settings.name, 'On', value);
                var payload = value ? settings.payload.onTrue : settings.payload.onFalse;
                if (mqttStatus[settings.topic.statusOn] !== payload) {
                    // this should prevent flickering while dimming lights that use
                    // the same topic for On and Brightness, e.g. Homematic Dimmers
                    if ((settings.topic.setOn !== settings.topic.setBrightness) || !value) {
                        log.debug('> mqtt', settings.topic.setOn, payload);
                        mqttPub(settings.topic.setOn, payload);
                    } else {
                        setTimeout(function () {
                            if (!mqttStatus[settings.topic.statusBrightness]) {
                                mqttPub(settings.topic.setOn, payload);
                            }
                        }, 300)
                    }
                }
                callback();
            });

        //update status in homekit if exernal status gets updated
        mqttSub(settings.topic.statusOn, function (val) {
            log.debug('> hap set', settings.name, 'On', mqttStatus[settings.topic.statusOn]);
            light.getService(Service.Lightbulb)
                .getCharacteristic(Characteristic.On)
                .getValue();
        });

        light.getService(Service.Lightbulb)
            .getCharacteristic(Characteristic.On)
            .on('get', function (callback) {
                log.debug('< hap get', settings.name, 'On');
                var on = mqttStatus[settings.topic.statusOn] !== settings.payload.onFalse;
                log.debug('> hap re_get', settings.name, 'On', on);
                callback(null, on);
            });

        if (settings.topic.setBrightness) {
            light.getService(Service.Lightbulb)
                .addCharacteristic(Characteristic.Brightness)
                .on('set', function (value, callback) {
                    log.debug('< hap set', settings.name, 'Brightness', value);
                    var bri = (value * (settings.payload.brightnessFactor || 1)) || 0;
                    log.debug('> mqtt', settings.topic.setBrightness, bri);
                    mqttPub(settings.topic.setBrightness, bri);
                    callback();
                });

            if (settings.topic.statusBrightness) {

                //update status in homekit if exernal status gets updated
                mqttSub(settings.topic.statusBrightness, function(val) {
                    log.debug('> hap set', settings.name, 'Brightness', mqttStatus[settings.topic.statusBrightness]);
                    light.getService(Service.Lightbulb)
                        .getCharacteristic(Characteristic.Brightness)
                        .getValue();
                });

                light.getService(Service.Lightbulb)
                    .getCharacteristic(Characteristic.Brightness)
                    .on('get', function (callback) {
                        log.debug('< hap get', settings.name, 'Brightness');
                        var brightness = (mqttStatus[settings.topic.statusBrightness] / (settings.payload.brightnessFactor || 1)) || 0;

                        log.debug('> hap re_get', settings.name, 'Brightness', brightness);
                        callback(null, brightness);
                    });

            }

        }

        if (settings.topic.setHue) {
            light.getService(Service.Lightbulb)
                .addCharacteristic(Characteristic.Hue)
                .on('set', function (value, callback) {
                    log.debug('< hap set', settings.name, 'Hue', value);
                    log.debug('> mqtt', settings.topic.setHue, (value * (settings.payload.hueFactor || 1)));
                    mqttPub(settings.topic.setHue, (value * (settings.payload.hueFactor || 1)));
                    callback();
                });
            if (settings.topic.statusHue) {
                mqttSub(settings.topic.statusHue);
                light.getService(Service.Lightbulb)
                    .getCharacteristic(Characteristic.Hue)
                    .on('get', function (callback) {
                        log.debug('< hap get', settings.name, 'Hue');
                        var hue = (mqttStatus[settings.topic.statusHue] / (settings.payload.hueFactor || 1)) || 0;

                        log.debug('> hap re_get', settings.name, 'Hue', hue);
                        callback(null, hue);
                    });

            }
        }

        if (settings.topic.setSaturation) {
            light.getService(Service.Lightbulb)
                .addCharacteristic(Characteristic.Saturation)
                .on('set', function (value, callback) {
                    log.debug('< hap set', settings.name, 'Saturation', value);
                    var sat = (value * (settings.payload.saturationFactor || 1)) || 0;
                    log.debug('> mqtt', settings.topic.setSaturation, sat);
                    mqttPub(settings.topic.setSaturation, sat);
                    callback();
                });
            if (settings.topic.statusSaturation) {
                mqttSub(settings.topic.statusSaturation);
                light.getService(Service.Lightbulb)
                    .getCharacteristic(Characteristic.Saturation)
                    .on('get', function (callback) {
                        log.debug('< hap get', settings.name, 'Saturation');
                        var saturation = (mqttStatus[settings.topic.statusSaturation] / (settings.payload.saturationFactor || 1)) || 0;

                        log.debug('> hap re_get', settings.name, 'Saturation', saturation);
                        callback(null, saturation);
                    });

            }
        }


        return light;

    },
    LightSensor: function createAccessory_LightSensor(settings) {

        var sensor = newAccessory(settings);

        mqttSub(settings.topic.statusAmbientLightLevel, function(val) {
            log.debug('> hap set', settings.name, 'CurrentAmbientLightLevel', mqttStatus[settings.topic.statusAmbientLightLevel]);
            sensor.getService(Service.LightSensor)
                .setCharacteristic(Characteristic.CurrentAmbientLightLevel,val);
        });

        sensor.addService(Service.LightSensor)
            .getCharacteristic(Characteristic.CurrentAmbientLightLevel)
            .on('get', function(callback) {
                log.debug('< hap get', settings.name, 'LightSensor', 'CurrentAmbientLightLevel');
                log.debug('> hap re_get', settings.name, mqttStatus[settings.topic.statusAmbientLightLevel]);
                callback(null, mqttStatus[settings.topic.statusAmbientLightLevel]);
            });

        return sensor;
    },
    LockMechanism: function createAccessory_LockMechanism(settings) {

        var lock = newAccessory(settings);

        lock.addService(Service.LockMechanism, settings.name)
            .getCharacteristic(Characteristic.LockTargetState)
            .on('set', function(value, callback) {
                log.debug('< hap set', settings.name, 'LockTargetState', value);

                if (value == Characteristic.LockTargetState.UNSECURED) {
                    log.debug('> mqtt publish', settings.topic.setLock, settings.payload.lockUnsecured);
                    mqttPub(settings.topic.setLock, settings.payload.lockUnsecured);

                    callback();

                } else if (value == Characteristic.LockTargetState.SECURED) {

                    log.debug('> mqtt publish', settings.topic.setLock, settings.payload.lockSecured);
                    mqttPub(settings.topic.setLock, settings.payload.lockSecured);

                    callback();

                }
            });

        if (settings.topic.statusLock) {

            var initial = true;

            mqttSub(settings.topic.statusLock, function (val) {
                if (val === settings.payload.lockSecured) {
                    log.debug('> hap set', settings.name, 'LockCurrentState.SECURED');
                    lock.getService(Service.LockMechanism)
                        .setCharacteristic(Characteristic.LockCurrentState, Characteristic.LockCurrentState.SECURED);
                    if (initial) {
                        log.debug('> hap set', settings.name, 'LockTargetState.SECURED');
                        lock.getService(Service.LockMechanism)
                            .setCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.SECURED);
                        initial = false;
                    }
                } else {
                    log.debug('> hap set', settings.name, 'LockCurrentState.UNSECURED');
                    lock.getService(Service.LockMechanism)
                        .setCharacteristic(Characteristic.LockCurrentState, Characteristic.LockCurrentState.UNSECURED);
                    if (initial) {
                        log.debug('> hap set', settings.name, 'LockTargetState.UNSECURED');
                        lock.getService(Service.LockMechanism)
                            .setCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.UNSECURED);
                        initial = false;
                    }
                }
            });

            lock.getService(Service.LockMechanism)
                .getCharacteristic(Characteristic.LockCurrentState)
                .on('get', function(callback) {
                    log.debug('< hap get', settings.name, 'LockCurrentState');

                    if (mqttStatus[settings.topic.statusLock] === settings.payload.lockSecured) {
                        log.debug('> hap re_get', settings.name, 'LockCurrentState.SECURED');
                        callback(null, Characteristic.LockCurrentState.SECURED);
                    } else {
                        log.debug('> hap re_get', settings.name, 'LockCurrentState.UNSECURED');
                        callback(null, Characteristic.LockCurrentState.UNSECURED);
                    }
                });
        }

        return lock;
    },
    MotionSensor: function createAccessory_MotionSensor(settings) {

        var sensor = newAccessory(settings);

        sensor.addService(Service.MotionSensor, settings.name)
            .getCharacteristic(Characteristic.MotionDetected)
            .on('get', function (callback) {
                log.debug('< hap get', settings.name, 'MotionDetected');
                var motion = mqttStatus[settings.topic.statusMotionDetected] === settings.payload.onMotionDetected;

                log.debug('> hap re_get', settings.name, 'MotionDetected', motion);
                callback(null, motion);
            });

        mqttSub(settings.topic.statusMotionDetected, function (val) {
            var motion = val === settings.payload.onMotionDetected;
            log.debug('> hap set', settings.name, 'MotionDetected', motion);
            sensor.getService(Service.MotionSensor)
                .setCharacteristic(Characteristic.MotionDetected, motion)
        });

        if (settings.topic.statusLowBattery) {
            sensor.addService(Service.ContactSensor, settings.name)
                .getCharacteristic(Characteristic.StatusLowBattery)
                .on('get', function (callback) {
                    log.debug('< hap get', settings.name, 'StatusLowBattery');
                    var bat = mqttStatus[settings.topic.statusLowBattery] === settings.payload.onLowBattery
                        ? Characteristic.StatusLowBattery.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                        : Characteristic.StatusLowBattery.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;

                    log.debug('> hap re_get', settings.name, 'StatusLowBattery', bat);
                    callback(null, bat);
                });

            mqttSub(settings.topic.statusLowBattery, function (val) {
                var bat = val === settings.payload.onLowBattery
                    ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                    : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
                log.debug('> hap set', settings.name, 'statusLowBattery', bat);
                sensor.getService(Service.ContactSensor)
                    .setCharacteristic(Characteristic.StatusLowBattery, bat)
            });
        }

        return sensor;

    },
    OccupancySensor: function createAccessory_OccupancySensor(settings) {

        var sensor = newAccessory(settings);

        sensor.addService(Service.OccupancySensor, settings.name)
            .getCharacteristic(Characteristic.OccupancyDetected)
            .on('get', function (callback) {
                log.debug('< hap get', settings.name, 'OccupancyDetected');
                var motion = mqttStatus[settings.topic.statusOccupancyDetected] === settings.payload.onOccupancyDetected;

                log.debug('> hap re_get', settings.name, 'OccupancyDetected', motion ?
                    Characteristic.OccupancyDetected.OCCUPANCY_DETECTED :
                    Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
                callback(null, motion);
            });

        mqttSub(settings.topic.statusOccupancyDetected, function (val) {
            var motion = val === settings.payload.onOccupancyDetected;
            log.debug('> hap set', settings.name, 'OccupancyDetected', motion);
            sensor.getService(Service.OccupancySensor)
                .setCharacteristic(Characteristic.OccupancyDetected, motion ?
                    Characteristic.OccupancyDetected.OCCUPANCY_DETECTED :
                    Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED)
        });

        if (settings.topic.statusLowBattery) {
            sensor.addService(Service.ContactSensor, settings.name)
                .getCharacteristic(Characteristic.StatusLowBattery)
                .on('get', function (callback) {
                    log.debug('< hap get', settings.name, 'StatusLowBattery');
                    var bat = mqttStatus[settings.topic.statusLowBattery] === settings.payload.onLowBattery
                        ? Characteristic.StatusLowBattery.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                        : Characteristic.StatusLowBattery.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;

                    log.debug('> hap re_get', settings.name, 'StatusLowBattery', bat);
                    callback(null, bat);
                });

            mqttSub(settings.topic.statusLowBattery, function (val) {
                var bat = val === settings.payload.onLowBattery
                    ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                    : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
                log.debug('> hap set', settings.name, 'statusLowBattery', bat);
                sensor.getService(Service.ContactSensor)
                    .setCharacteristic(Characteristic.StatusLowBattery, bat)
            });
        }

        return sensor;

    },
    SmokeSensor: function createAccessory_SmokeSensor(settings) {

        var sensor = newAccessory(settings);

        sensor.addService(Service.SmokeSensor, settings.name)
            .getCharacteristic(Characteristic.SmokeDetected)
            .on('get', function (callback) {
                log.debug('< hap get', settings.name, 'SmokeDetected');
                var smoke = mqttStatus[settings.topic.statusSmokeDetected] === settings.payload.onSmokeDetected
                    ? Characteristic.SmokeDetected.SMOKE_DETECTED
                    : Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;

                log.debug('> hap re_get', settings.name, 'SmokeDetected', smoke);
                callback(null, smoke);
            });

        mqttSub(settings.topic.statusSmokeDetected, function (val) {
            var smoke = val === settings.payload.onSmokeDetected
                ? Characteristic.SmokeDetected.SMOKE_DETECTED
                : Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
            log.debug('> hap set', settings.name, 'SmokeDetected', smoke);
            sensor.getService(Service.SmokeSensor)
                .setCharacteristic(Characteristic.SmokeDetected, smoke)
        });

        if (settings.topic.statusLowBattery) {
            sensor.getService(Service.SmokeSensor, settings.name)
                .getCharacteristic(Characteristic.StatusLowBattery)
                .on('get', function (callback) {
                    log.debug('< hap get', settings.name, 'StatusLowBattery');
                    var bat = mqttStatus[settings.topic.statusLowBattery] === settings.payload.onLowBattery
                        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
                    log.debug('> hap re_get', settings.name, 'StatusLowBattery', bat);
                    callback(null, bat);
                });

            mqttSub(settings.topic.statusLowBattery, function (val) {
                var bat = val === settings.payload.onLowBattery
                    ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                    : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
                log.debug('> hap set', settings.name, 'StatusLowBattery', bat);
                sensor.getService(Service.SmokeSensor)
                    .setCharacteristic(Characteristic.StatusLowBattery, bat)
            });
        }

        return sensor;

    },
    Speaker: function createAccessory_Speaker(settings) {
        var speaker = newAccessory(settings);

        speaker.addService(Service.Speaker, settings.name)
            .getCharacteristic(Characteristic.Mute)
            .on('set', function (value, callback) {
                log.debug('< hap set', settings.name, 'Mute', value);
                var mute = value ? settings.payload.muteTrue : settings.payload.muteFalse;
                log.debug('> mqtt', settings.topic.setOn, mute);
                mqttPub(settings.topic.setMute, mute);
                callback();
            });

        //update status in homekit if exernal status gets updated
        mqttSub(settings.topic.statusMute, function (val) {
            log.debug('> hap set', settings.name, 'Mute', mqttStatus[settings.topic.statusMute]);
            speaker.getService(Service.Speaker)
                .getCharacteristic(Characteristic.Mute)
                .getValue();
        });

        speaker.getService(Service.Speaker)
            .getCharacteristic(Characteristic.Mute)
            .on('get', function (callback) {
                log.debug('< hap get', settings.name, 'Mute');
                var mute = mqttStatus[settings.topic.statusMute] !== settings.payload.muteFalse;
                log.debug('> hap re_get', settings.name, 'Mute', mute);
                callback(null, mute);
            });

        if (settings.topic.setVolume) {
            speaker.getService(Service.Speaker)
                .addCharacteristic(Characteristic.Volume)
                .on('set', function (value, callback) {
                    log.debug('< hap set', settings.name, 'Volume', value);
                    var volume = (value * (settings.payload.volumeFactor || 1)) || 0;
                    log.debug('> mqtt', settings.topic.setVolume, volume);
                    mqttPub(settings.topic.setVolume, volume);
                    callback();
                });

            if (settings.topic.statusVolume) {

                //update status in homekit if exernal status gets updated
                mqttSub(settings.topic.statusVolume, function(val) {
                    log.debug('> hap set', settings.name, 'Volume', mqttStatus[settings.topic.statusVolume]);
                    speaker.getService(Service.Speaker)
                        .getCharacteristic(Characteristic.Volume)
                        .getValue();
                });

                speaker.getService(Service.Speaker)
                    .getCharacteristic(Characteristic.Volume)
                    .on('get', function (callback) {
                        log.debug('< hap get', settings.name, 'Volume');
                        var volume = (mqttStatus[settings.topic.statusVolume] / (settings.payload.volumeFactor || 1)) || 0;

                        log.debug('> hap re_get', settings.name, 'Volume', volume);
                        callback(null, volume);
                    });

            }

        }

        return speaker;

    },
    StatelessProgrammableSwitch: function createAccessory_StatelessProgrammableSwitch (settings) {
        var sw = newAccessory(settings);

        sw.addService(Service.StatelessProgrammableSwitch, settings.name);

        mqttSub(settings.topic.statusEvent, function () {
            log.debug('> hap set', settings.name, 'ProgrammableSwitchEvent', 1);
            sw.getService(Service.StatelessProgrammableSwitch)
                .setCharacteristic(Characteristic.ProgrammableSwitchEvent, 1)
        });


        return sw;
    },
    Switch: function createAccessory_Switch(settings) {

        var sw = newAccessory(settings);

        sw.addService(Service.Switch, settings.name)
            .getCharacteristic(Characteristic.On)
            .on('set', function(value, callback) {
                log.debug('< hap set', settings.name, 'On', value);
                var on = value ? settings.payload.onTrue : settings.payload.onFalse;
                log.debug('> mqtt', settings.topic.setOn, on);
                mqttPub(settings.topic.setOn, on);
                callback();
            });

        if (settings.topic.statusOn) {
            mqttSub(settings.topic.statusOn);
            sw.getService(Service.Switch)
                .getCharacteristic(Characteristic.On)
                .on('get', function (callback) {
                    log.debug('< hap get', settings.name, 'On');
                    var on = mqttStatus[settings.topic.statusOn] === settings.payload.onTrue;
                    log.debug('> hap re_get', settings.name, 'On', on);
                    callback(null, on);
                });

        }

        return sw;

    },
    TemperatureSensor: function createAccessory_TemperatureSensor(settings) {

        var sensor = newAccessory(settings);

        mqttSub(settings.topic.statusTemperature, function (val) {
            log.debug('> hap set', settings.name, 'CurrentTemperature', mqttStatus[settings.topic.statusTemperature]);
            sensor.getService(Service.TemperatureSensor)
                .setCharacteristic(Characteristic.CurrentTemperature, val);
        });

        sensor.addService(Service.TemperatureSensor)
            .getCharacteristic(Characteristic.CurrentTemperature)
            .on('get', function(callback) {
                log.debug('< hap get', settings.name, 'TemperatureSensor', 'CurrentTemperature');
                log.debug('> hap re_get', settings.name, mqttStatus[settings.topic.statusTemperature]);
                callback(null, mqttStatus[settings.topic.statusTemperature]);
            });

        return sensor;
    },
    Thermostat: function createAccessory_Thermostat(settings) {

        var thermo = newAccessory(settings);

        thermo.addService(Service.Thermostat, settings.name)
            .getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .on('set', function(value, callback) {
                log.debug('< hap set', settings.name, 'TargetHeatingCoolingState', value);
                if (settings.topic.setTargetHeatingCoolingState) {
                    log.debug('> mqtt', settings.topic.setTargetHeatingCoolingState, value);
                    mqttPub(settings.topic.setTargetHeatingCoolingState, value);
                }
                callback();
            });

        thermo.getService(Service.Thermostat)
            .getCharacteristic(Characteristic.TargetTemperature)
            .on('set', function(value, callback) {
                log.debug('< hap set', settings.name, 'TargetTemperature', value);
                log.debug('> mqtt', settings.topic.setTargetTemperature, value);
                mqttPub(settings.topic.setTargetTemperature, value);
                callback();
            });

        thermo.getService(Service.Thermostat)
            .getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .on('set', function(value, callback) {
                log.debug('< hap set', settings.name, 'TemperatureDisplayUnits', value);
                log.debug('> config', settings.name, 'TemperatureDisplayUnits', value);
                settings.config.TemperatureDisplayUnits = value;
                callback();
            });

        thermo.getService(Service.Thermostat)
            .getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .on('get', function (callback) {
                log.debug('< hap get', settings.name, 'TemperatureDisplayUnits');
                log.debug('> hap re_get', settings.name, 'TemperatureDisplayUnits', settings.config.TemperatureDisplayUnits);
                callback(null, settings.config.TemperatureDisplayUnits);
            });

        mqttSub(settings.topic.statusCurrentTemperature);
        thermo.getService(Service.Thermostat)
            .getCharacteristic(Characteristic.CurrentTemperature)
            .on('get', function (callback) {
                log.debug('< hap get', settings.name, 'CurrentTemperature');
                log.debug('> hap re_get', settings.name, 'CurrentTemperature', mqttStatus[settings.topic.statusCurrentTemperature]);
                callback(null, mqttStatus[settings.topic.statusCurrentTemperature]);
            });

        thermo.getService(Service.Thermostat)
            .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
            .on('get', function (callback) {
                log.debug('< hap get', settings.name, 'CurrentHeatingCoolingState');
                var state = 1; // HEATING
                log.debug('> hap re_get', settings.name, 'CurrentHeatingCoolingState', state);
                callback(null, state);
            });

        //thermo.getService(Service.Thermostat).setCharacteristic(Characteristic.CurrentHeatingCoolingState, 3);

        mqttSub(settings.topic.statusTargetTemperature/*, function (val) {
            thermo.getService(Service.Thermostat)
                .setCharacteristic(Characteristic.TargetTemperature, val);
        }*/);

        thermo.getService(Service.Thermostat)
            .getCharacteristic(Characteristic.TargetTemperature)
            .on('get', function (callback) {
                log.debug('< hap get', settings.name, 'TargetTemperature');
                log.debug('> hap re_get', settings.name, 'TargetTemperature', mqttStatus[settings.topic.statusTargetTemperature]);
                callback(null, mqttStatus[settings.topic.statusTargetTemperature]);
            });

        if (settings.topic.statusCurrentRelativeHumidity) {
            mqttSub(settings.topic.statusCurrentRelativeHumidity, function (val) {
                thermo.getService(Service.Thermostat)
                    .setCharacteristic(Characteristic.CurrentRelativeHumidity, val)
            });
            thermo.getService(Service.Thermostat)
                .getCharacteristic(Characteristic.CurrentRelativeHumidity)
                .on('get', function (callback) {
                    log.debug('< hap get', settings.name, 'CurrentRelativeHumidity');
                    log.debug('> hap re_get', settings.name, 'CurrentRelativeHumidity', mqttStatus[settings.topic.statusCurrentRelativeHumidity]);
                    callback(null, mqttStatus[settings.topic.statusCurrentRelativeHumidity]);
                });
        }

        if (settings.topic.setTargetRelativeHumidity) {
            thermo.getService(Service.Thermostat)
                .getCharacteristic(Characteristic.TargetRelativeHumidity)
                .on('set', function(value, callback) {
                    log.debug('< hap set', settings.name, 'TargetRelativeHumidity', value);
                    log.debug('> mqtt', settings.topic.setTargetRelativeHumidity, value);
                    mqttPub(settings.topic.setTargetRelativeHumidity, value);
                    callback();
                });
        }

        if (settings.topic.setCoolingThresholdTemperature) {
            thermo.getService(Service.Thermostat)
                .getCharacteristic(Characteristic.CoolingThresholdTemperature)
                .on('set', function(value, callback) {
                    log.debug('< hap set', settings.name, 'CoolingThresholdTemperature', value);
                    log.debug('> mqtt', settings.topic.setCoolingThresholdTemperature, value);
                    mqttPub(settings.topic.setCoolingThresholdTemperature, value);
                    callback();
                });
        }


        if (settings.topic.statusCoolingThresholdTemperature) {
            mqttSub(settings.topic.statusCoolingThresholdTemperature);
            thermo.getService(Service.Thermostat)
                .getCharacteristic(Characteristic.CoolingThresholdTemperature)
                .on('get', function (callback) {
                    log.debug('< hap get', settings.name, 'CoolingThresholdTemperature');
                    log.debug('> hap re_get', settings.name, 'CoolingThresholdTemperature', mqttStatus[settings.topic.statusCoolingThresholdTemperature]);
                    callback(null, mqttStatus[settings.topic.statusCoolingThresholdTemperature]);
                });
        }

        if (settings.topic.setHeatingThresholdTemperature) {
            mqttSub(settings.topic.setHeatingThresholdTemperature);
            thermo.getService(Service.Thermostat)
                .getCharacteristic(Characteristic.HeatingThresholdTemperature)
                .on('set', function(value, callback) {
                    log.debug('< hap set', settings.name, 'HeatingThresholdTemperature', value);
                    log.debug('> mqtt', settings.topic.setHeatingThresholdTemperature, value);
                    mqttPub(settings.topic.setHeatingThresholdTemperature, value);
                    callback();
                });
        }

        if (settings.topic.statusHeatingThresholdTemperature) {
            mqttSub(settings.topic.statusHeatingThresholdTemperature);
            thermo.getService(Service.Thermostat)
                .getCharacteristic(Characteristic.HeatingThresholdTemperature)
                .on('get', function (callback) {
                    log.debug('< hap get', settings.name, 'HeatingThresholdTemperature');
                    log.debug('> hap re_get', settings.name, 'HeatingThresholdTemperature', mqttStatus[settings.topic.statusHeatingThresholdTemperature]);
                    callback(null, mqttStatus[settings.topic.statusHeatingThresholdTemperature]);
                });
        }

        return thermo;

    },
    WindowCovering: function createAccessory_WindowCovering(settings) {
        var shutter = newAccessory(settings);

        shutter.addService(Service.WindowCovering, settings.name)
            .getCharacteristic(Characteristic.TargetPosition)
            .on('set', function (value, callback) {
                log.debug('< hap set', settings.name, 'TargetPosition', value);
                value = (value * (settings.payload.targetPositionFactor || 1));
                if (settings.payload.roundTarget === true) {
                    value = Math.round(value);
                }
                log.debug('> mqtt', settings.topic.setTargetPosition, value);
                mqttPub(settings.topic.setTargetPosition, value);
                callback();
            });

        if (settings.topic.statusTargetPosition) {
            mqttSub(settings.topic.statusTargetPosition);
            shutter.getService(Service.WindowCovering)
                .getCharacteristic(Characteristic.TargetPosition)
                .on('get', function (callback) {
                    log.debug('< hap get', settings.name, 'TargetPosition');
                    var position = mqttStatus[settings.topic.statusTargetPosition] / (settings.payload.targetPositionFactor || 1);
                    log.debug('> hap re_get', settings.name, 'TargetPosition', position);
                    callback(null, position);
                });
        }

        if (settings.topic.statusCurrentPosition) {
            mqttSub(settings.topic.statusCurrentPosition, function (val) {
                var pos = val / (settings.payload.currentPositionFactor || 1);
                log.debug('> hap set', settings.name, 'CurrentPosition', pos);
                shutter.getService(Service.WindowCovering)
                    .setCharacteristic(Characteristic.CurrentPosition, pos)

            });
            shutter.getService(Service.WindowCovering)
                .getCharacteristic(Characteristic.CurrentPosition)
                .on('get', function (callback) {
                    log.debug('< hap get', settings.name, 'CurrentPosition');
                    var position = mqttStatus[settings.topic.statusCurrentPosition] / (settings.payload.currentPositionFactor || 1);

                    log.debug('> hap re_get', settings.name, 'CurrentPosition', position);
                    callback(null, position);
                });
        }

        if (settings.topic.statusPositionStatus) {
            mqttSub(settings.topic.statusPositionStatus, function (val) {
                var pos;
                if (val === settings.payload.positionStatusDecreasing) {
                    pos = Characteristic.PositionState.DECREASING;
                    log.debug('> hap set', settings.name, 'PositionState.DECREASING');
                } else if (val === settings.payload.positionStatusIncreasing) {
                    pos = Characteristic.PositionState.INCREASING;
                    log.debug('> hap set', settings.name, 'PositionState.INCREASING');
                } else {
                    pos = Characteristic.PositionState.STOPPED;
                    log.debug('> hap set', settings.name, 'PositionState.STOPPED');
                }
                shutter.getService(Service.WindowCovering)
                    .setCharacteristic(Characteristic.PositionState, pos);
            });
            shutter.getService(Service.WindowCovering)
                .getCharacteristic(Characteristic.PositionState)
                .on('get', function (callback) {
                    log.debug('< hap get', settings.name, 'PositionState');

                    if (mqttStatus[settings.topic.statusPositionState] === settings.payload.positionStatusDecreasing) {
                        log.debug('> hap re_get', settings.name, 'PositionState.DECREASING');
                        callback(null, Characteristic.PositionState.DECREASING);
                    } else if (mqttStatus[settings.topic.statusPositionState] === settings.payload.positionStatusIncreasing) {
                        log.debug('> hap re_get', settings.name, 'PositionState.INCREASING');
                        callback(null,  Characteristic.PositionState.INCREASING);
                    } else {
                        log.debug('> hap re_get', settings.name, 'PositionState.STOPPED');
                        callback(null, Characteristic.PositionState.STOPPED);
                    }

                });
        }

        return shutter;

    }
};

var accCount = 0;
Object.keys(mapping).forEach(function (id) {
    var a = mapping[id];
    a.id = id;
    if (createAccessory[a.service]) {
        log.debug('addBridgedAccessory ' + a.service + ' ' + a.name);
        bridge.addBridgedAccessory(createAccessory[a.service](a));
        accCount++;
    } else {
        log.err('unknown service', a.service, id);
    }
});
log.info('hap created', accCount, 'Accessories');

log('hap publishing bridge "' + config.bridgename + '" username=' + config.username, 'port=' + config.port, 'pincode=' + config.c);
bridge.publish({
    username: config.username,
    port: config.port,
    pincode: config.c,
    category: Accessory.Categories.OTHER
});

// Listen for bridge identification event
bridge._server.on('listening', function () {
    log('hap Bridge listening on port', config.port);
});

// Listen for bridge pair event
bridge._server.on('pair', function (username, publickey) {
    log('hap paired', username);
});

// Listen for bridge unpair event
bridge._server.on('unpair', function (username) {
    log('hap unpaired', username);
});

// Listen for bridge verify event
bridge._server.on('verify', function () {
    log('hap verify');
});
