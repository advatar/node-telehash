var dgram = require("dgram");
var os = require("os");
var async = require("async");
var ursa = require("ursa")
var dhash = require("./dhash").Hash;

var REQUEST_TIMEOUT = 5 * 1000; // default timeout for any request
var warn = console.log; // switch to function(){} to disable
var debug = function(){}; // switch to console.log to enable

exports.hash = function(string)
{
  return new dhash(string);
}

// simple handy wrapper utility to make a new keypair
exports.createKeys = function(mod, exp)
{
  var key = ursa.generatePrivateKey(mod, exp);
  return {public:key.toPublicPem("utf8"), private:key.toPrivatePem("utf8")};
}

// start a hashname listening and ready to go
exports.hashname = function(space, privateKey, args)
{
  if(!space || !privateKey) return undefined;
  if(!args) args = {};

  // configure defaults
  var self = {space:space, cb:{}, operators:[], watch:{}};
  // parse/validate the private key
  try {
    self.ukey = ursa.coercePrivateKey(privateKey);
    self.pubkey = self.ukey.toPublicPem("utf8");
  } catch(E) {
    warn("couldn't parse key:", E);
    return undefined;
  };
  self.hashname = new dhash(self.pubkey+space).toString();
  if (!args.ip || args.natted) self.nat = true;
  self.ip = args.ip || "0.0.0.0";
  self.port = parseInt(args.port) || 0;


  // udp socket
  self.server = dgram.createSocket("udp4", function(msg, rinfo){
    var packet = decode(msg);
    if(!packet) return warn("failed to decode a packet from", rinfo.address, rinfo.port, msg.toString());
    packet.from = {ip:rinfo.address, port:rinfo.port};
    incoming(self, packet);
  });
  self.server.bind(self.port, self.ip);

  // try to set the correct address for logging, not important for telehash
  self.port = self.server.address().port;
  if(self.ip == "0.0.0.0") {
    var better;
    var ifaces = os.networkInterfaces()
    for (var dev in ifaces) {
      ifaces[dev].forEach(function(details){
        if(!better && details.family == "IPv4" && dev.substr(0,1) == "e") better = details.address;
      });
    }
    if(better) self.ip = better;
  }
  self.address = [self.hashname, self.ip, self.port].join(",");

  // set up methods (personal prefernce to do this explicitly vs. prototype pattern)
  self.myLookup = function(callback) { this.cb.lookup = callback };
  self.setOperators = function(operators) { this.operators = operators.map(parseAddress) || [] };
  self.doWho = function(hn, callback) { who(this, hn, callback) };

  return self;
}

// perform a who request
function who(self, hn, callback)
{
  var key;
  async.forEachSeries(self.operators, function(op, cbOps){
    var body = new Buffer(JSON.stringify({hashname:hn, from:self.hashname, to:op.hashname, space:self.space, x:Date.now()+10000}));
    var js = {sig:self.ukey.hashAndSign("md5", body).toString("base64")};
    js.who = new dhash(js.sig).toString();
    keywatch(self, js.who, function(err, value){
      if(value) key = value;
      cbOps(value); // stops async when we get a value
    });
    send(self, op, encode(js, body));
  }, function(){
    if(!key) return callback("not found");
    callback(null, key);
  });
}

function keywatch(self, key, callback)
{
  var timeout = setTimeout(function(){done("timeout")}, REQUEST_TIMEOUT);
  function done(err, value)
  {
    if(!timeout) return; // re-entered by accident if answer came after timeout
    clearTimeout(timeout);
    timeout = false;
    delete self.watch[key];
    callback(err, value);
  }
  
  self.watch[key] = {done:done, parts:[]};
}

// wiring wrapper
function send(self, to, buf)
{
  self.server.send(buf, 0, buf.length, to.port, to.ip);
}

// just parse the "60518c1c11dc0452be71a7118a43ab68e3451b82,172.16.42.34,65148" format
function parseAddress(str)
{
  var parts = str.split(",");
  return {hashname:parts[0], ip:parts[1], port:parseInt(parts[2])};
}

// create a wire writeable packet
function encode(js, body)
{
  debug("ENCODING", js, body && body.length);
  var jsbuf = new Buffer(JSON.stringify(js), "utf8");
  if(typeof body === "string") body = new Buffer(body, "utf8");
  body = body || new Buffer(0);
  var len = new Buffer(2);
  len.writeInt16BE(jsbuf.length, 0);
  return Buffer.concat([len, jsbuf, body]);
}

// decode a packet from a buffer
function decode(buf)
{
  // read and validate the json length
  var len = buf.readUInt16BE(0);
  if(len == 0 || len > (buf.length - 2)) return undefined;

  // parse out the json
  var packet = {};
  try {
      packet.js = JSON.parse(buf.toString("utf8",2,len+2));
  } catch(E) {
    return undefined;
  }

  // if any body, attach it as a buffer
  if(buf.length > (len + 2)) packet.body = buf.slice(len + 2);
  
  return packet;
}

// figure out what this packet is and have some fun
function incoming(self, packet)
{
  debug("INCOMING", self.hashname, "packet from", packet.from, packet.js, packet.body && packet.body.length);
  
  if(packet.js.who) inWho(self, packet);
  if(packet.js.key) inKey(self, packet);
  
}

function inKey(self, packet)
{
  var watch = self.watch[packet.js.key];
  if(!watch) return warn("unknown key from", packet.from);

  // some sanity checks
  if(!packet.body) return warn("missing key body from", packet.from);
  var seq = parseInt(packet.js.seq || 0);
  if(seq === NaN || seq < 0 || seq > 10) return warn("invalid seq", packet.js.seq, packet.from);

  watch.parts[seq] = packet.body.toString("utf8");

  // check if it's a valid public key yet
  var key = watch.parts.join("");
  try { ursa.coercePublicKey(key) } catch(E) { return warn(E)};
  watch.done(null, key);
}

function inWho(self, packet)
{
  try { packet.body = JSON.parse(packet.body.toString()) } catch(E) { return warn("invalid body from", packet.from); }
  
  function valued(err, key)
  {
    // split into 1k chunks max
    var chunks = [].concat.apply([], key.split('').map(function(x,i){ return i%1000 ? [] : key.slice(i,i+1000) }));
    for(var i = 0; i < chunks.length; i++)
    {
      send(self, packet.from, encode({key:packet.js.who, seq:i}, chunks[i]));
    }
  }
  
  if(packet.body.hashname === self.hashname) return valued(null, self.pubkey);
  if(self.cb.lookup) return self.cb.lookup(packet.body.hashname, valued);
}