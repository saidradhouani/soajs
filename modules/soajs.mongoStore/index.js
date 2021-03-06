'use strict';

var Mongo = require('../soajs.mongo');
var util = require('util');

/**
 *
 * @type {{name: string, prefix: string, servers: {host: string, port: number}[], credentials: null, URLParam: {connectTimeoutMS: number, socketTimeoutMS: number, maxPoolSize: number, w: number, wtimeoutMS: number, slaveOk: boolean}, extraParam: {db: {native_parser: boolean}, server: {auto_reconnect: boolean}}, store: {}, collection: string, stringify: boolean, expireAfter: number}}
 */
var defaultOptions = {
    "name": "sessionDB",
    "prefix": "",
    "servers": [
        {"host": "127.0.0.1", "port": 27017 }
    ],
    "credentials": null,
    "URLParam": {
        "connectTimeoutMS": 0,
        "socketTimeoutMS": 0,
        "maxPoolSize": 5,
        "w": 1,
        "wtimeoutMS": 0,
        "slaveOk": true
    },
    "extraParam": {
        "db": {
            "native_parser": true
        },
        "server": {
            "auto_reconnect": true
        }
    },
    'store': {},
    "collection": "sessions",
    'stringify': false,
    'expireAfter': 1000 * 60 * 60 * 24 * 14 // 2 weeks
};

/**
 *
 * @param connect
 * @returns {MongoStore}
 */
module.exports = function (connect) {
    var Store = connect.Store || connect.session.Store;

    /**
     * Initialize MongoStore with the given `options`.
     * Calls `callback` when db connection is ready (mainly for testing purposes).
     *
     * @param {Object} options
     * @param {Function} callback
     * @api public
     */

    function MongoStore(options) {
        options = options || {};

        for (var property in defaultOptions) {
            if (defaultOptions.hasOwnProperty(property)) {
                if (!options.hasOwnProperty(property) || (typeof defaultOptions[property] !== typeof options[property])) {
                    options[property] = defaultOptions[property];
                }
            }
        }

        Store.call(this, options.store);

        var dbProperties = ["name", "prefix", "servers", "credentials", "URLParam", "extraParam"];
        var dbPropertiesLen = dbProperties.length;
        var dbOptions = {};
        for (var i = 0; i < dbPropertiesLen; i++) {
            dbOptions[dbProperties[i]] = options[dbProperties[i]];
        }

        this.mongo = new Mongo(dbOptions);
        this.mongo.ensureIndex(options.collection, {expires: 1}, {expireAfterSeconds: 0}, function (err, result) {
            if (err) {
                throw new Error('Error setting TTL index on collection : ' + options.collection + ' <' + err + '>');
            }
        });

        //NOTE: we cannot stringify the session object. we need to keep it an object in mongo in order to support multi tenancy in the set method below
         this._options = {
            "collection": options.collection,
            "stringify": false,
            "expireAfter": options.expireAfter
        };
    }

    /**
     * Inherit from `Store`.
     */
    util.inherits(MongoStore, Store);

    /**
     * Attempt to fetch session by the given `sid`.
     *
     * @param {String} sid
     * @param {Function} cb
     * @api public
     */
    MongoStore.prototype.get = function (sid, cb) {
        var self = this;
        this.mongo.findOne(self._options.collection, {_id: sid}, function (err, session) {
            if (err) {
                return cb(err);
            }

            if (!session) {
                return cb();
            }

            if (!session.expires || new Date < session.expires) {
                return cb(null, deSerialize(self._options.stringify, session.session));
            }
            self.destroy(sid, cb);
        });
    };

    /**
     * Commit the given `session` object associated with the given `sid`.
     *
     * @param {String} sid
     * @param {Object} session
     * @param {Function} cb
     * @api public
     */
    MongoStore.prototype.set = function (sid, session, cb) {
        if (!session.persistSession || !session.persistSession.state || (session.persistSession.state && session.persistSession.state.DONE)) {
            return cb();
        }
        var self = this;
        var expiryDate = (session && session.cookie && session.cookie._expires) ? (new Date(session.cookie._expires)) : newDateFromFuture(self._options.expireAfter);
        var s = {
            '$set': {
                'expires': expiryDate
            }
        };
        var filter = {
            '_id': sid
        };
        var tenant = null;
        if (!(session.persistSession.state.ALL || session.persistSession.state.TENANT ) &&
            (session.persistSession.state.KEY || session.persistSession.state.SERVICE || session.persistSession.state.CLIENTINFO ||
                session.persistSession.state.URAC || session.persistSession.state.URACPACKAGE || session.persistSession.state.URACPACKAGEACL || session.persistSession.state.URACKEY || session.persistSession.state.URACKEYCONFIG || session.persistSession.state.URACKEYACL)) {
            tenant = getTenant(session);
            if (!tenant) {
                return cb();
            }

            //KEY
            //KEY --> SERVICE
            if (session.persistSession.state.KEY) {
                s.$set['session.sessions.' + tenant.id + '.keys.' + tenant.key] = session.sessions[tenant.id].keys[tenant.key];
            }
            else {
                if (session.persistSession.state.SERVICE) {
                    var request = getRequest(session);// session.sessions[tenant.id].key[tenant.key].request.service;
                    if (request && request.service) {
                        var service = request.service;
                        s.$set['session.sessions.' + tenant.id + '.keys.' + tenant.key + '.services.' + service] = session.sessions[tenant.id].keys[tenant.key].services[service];
                    }
                }
            }

            //CLIENTINFO
            if (session.persistSession.state.CLIENTINFO) {
                s.$set['session.sessions.' + tenant.id + '.clientInfo'] = session.sessions[tenant.id].clientInfo;
            }

            //URAC
            //URAC --> URACPACKAGE
            //URAC --> URACPACKAGE --> URACPACKAGEACL
            //URAC --> URACKEY
            //URAC --> URACKEY --> URACKEYACL
            //URAC --> URACKEY --> URACKEYCONFIG
            if (session.persistSession.state.URAC) {
                s.$set['session.sessions.' + tenant.id + '.urac'] = session.sessions[tenant.id].urac;
            }
            else {
                var product = null;
                if (session.persistSession.state.URACPACKAGE) {
                    product = getProduct(session);
                    if (product) {
                        s.$set['session.sessions.' + tenant.id + '.urac.config.packages.' + product.package] = session.sessions[tenant.id].urac.config.packages[product.package];
                    }
                }
                else {
                    if (session.persistSession.state.URACPACKAGEACL) {
                        product = getProduct(session);
                        if (product) {
                            s.$set['session.sessions.' + tenant.id + '.urac.config.packages.' + product.package + '.acl'] = session.sessions[tenant.id].urac.config.packages[product.package].acl;
                        }
                    }
                }
                if (session.persistSession.state.URACKEY) {
                    s.$set['session.sessions.' + tenant.id + '.urac.config.keys.' + tenant.key] = session.sessions[tenant.id].urac.config.keys[tenant.key];
                }
                else {
                    if (session.persistSession.state.URACKEYACL) {
                        s.$set['session.sessions.' + tenant.id + '.urac.config.keys.' + tenant.key + '.acl'] = session.sessions[tenant.id].urac.config.keys[tenant.key].acl;
                    }
                    if (session.persistSession.state.URACKEYCONFIG) {
                        s.$set['session.sessions.' + tenant.id + '.urac.config.keys.' + tenant.key + '.config'] = session.sessions[tenant.id].urac.config.keys[tenant.key].config;
                    }
                }
            }

            session.persistSession.state = {"DONE": true};
            s.$set['session.persistSession'] = session.persistSession;
        }
        else if (!session.persistSession.state.ALL && session.persistSession.state.TENANT) {
            tenant = getTenant(session);
            if (!tenant) {
                return cb();
            }
            s.$set['session.sessions.' + tenant.id] = session.sessions[tenant.id];

            session.persistSession.state = {"DONE": true};
            s.$set['session.persistSession'] = session.persistSession;
        }
        else { // if session.persistSession.state.ALL
            session.persistSession.state = {"DONE": true};
            s = {
                '_id': sid,
                'session': serialize(self._options.stringify, session),
                'expires': expiryDate
            };
        }
        if (session.persistSession.state.DONE) {
            this.mongo.update(self._options.collection, filter, s, { 'upsert': true, 'safe': true }, function (err, data) {
                if (err) {
                    return cb(err, null);
                } else {
                    return cb(err, data);
                }
            });
        }
        else
            return cb();
    };

    /**
     * Destroy the session associated with the given `sid`.
     *
     * @param {String} sid
     * @param {Function} cb
     * @api public
     */
    MongoStore.prototype.destroy = function (sid, cb) {

        this.mongo.remove(this._options.collection, {_id: sid}, cb);
    };

    /**
     * Fetch number of sessions.
     *
     * @param {Function} cb
     * @api public
     */
    MongoStore.prototype.length = function (cb) {

        this.mongo.count(this._options.collection, {}, cb);
    };

    /**
     * Clear all sessions.
     *
     * @param {Function} cb
     * @api public
     */
    MongoStore.prototype.clear = function (cb) {

        this.mongo.dropCollection(this._options.collection, cb);
    };

    return MongoStore;
};


/**
 *
 * @param session
 * @returns {*}
 */
function getRequest(session) {
    var request = null;
    if (session && session.persistSession && session.persistSession.holder && session.persistSession.holder.request) {
        if (session.persistSession.holder.request.service) {
            request = {
                'service': session.persistSession.holder.request.service,
                'api': session.persistSession.holder.request.api
            };
        }
    }
    return request;
}

/**
 *
 * @param session
 * @returns {*}
 */
function getProduct(session) {
    var product = null;
    if (session && session.persistSession && session.persistSession.holder && session.persistSession.holder.product) {
        if (session.persistSession.holder.product.product && session.persistSession.holder.product.package) {
            product = {
                'product': session.persistSession.holder.product.product,
                'package': session.persistSession.holder.product.package
            };
        }
    }
    return product;
}

/**
 *
 * @param session
 * @returns {*}
 */
function getTenant(session) {
    var tenant = null;
    if (session && session.persistSession && session.persistSession.holder && session.persistSession.holder.tenant) {
        if (session.persistSession.holder.tenant.id && session.persistSession.holder.tenant.key) {
            if (session.sessions[session.persistSession.holder.tenant.id]) {
                if (session.sessions[session.persistSession.holder.tenant.id].keys[session.persistSession.holder.tenant.key]) {
                    tenant = {
                        'id': session.persistSession.holder.tenant.id,
                        'key': session.persistSession.holder.tenant.key
                    };
                }
            }
        }
    }
    return tenant;
}

/**
 * Returns a data in the future. By default, returns now + 2 weeks.
 *
 * @param {Date} offset
 * @returns {Date}
 */
function newDateFromFuture(offset) {
    return new Date(Date.now() + offset);
}

/**
 * Return String or Object based on the stringify param.
 *
 * @param {Boolean} stringify
 * @param {Object} obj
 * @returns {*}
 */
function serialize(stringify, obj) {
    if (stringify) {
        return JSON.stringify(obj);
    }
    return obj;
}

/**
 * Return String or Object based on the stringify param.
 *
 * @param {Boolean} stringify
 * @param (String} str
 * @returns {*}
 */
function deSerialize(stringify, str) {
    if (stringify) {
        return JSON.parse(str);
    }
    return str;
}
