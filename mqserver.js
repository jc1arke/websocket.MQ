
// websocket-based server for mqlib

var sys = require('sys');
var fs = require('fs');
var net = require('net');

var WsStream = require('./wsstream/wsstream');
var mq = require('./mqlib');

var sMqStore = 'mqstore';
var sPid = sMqStore+'/.pid';

WsStream.prototype.close = function() {
  this.end();
  this.socket.destroy();
};

function noop(err) { if (err) throw err; }

function main(argv) {
  try {
  var aPid = fs.readFileSync(sPid);
  } catch (err) {
    if (err.errno !== process.ENOENT) throw err;
  }

  if (argv.length > 2) {
    switch (argv[2]) {
    case 'stop':
      if (!aPid) {
        console.log('no .pid file found');
        break;
      }
      try {
      process.kill(+aPid, 'SIGINT');
      } catch (err) {
        console.log(err.message);
        fs.unlink(sPid, noop);
      }
      break;
    case 'test':
      if (aPid) {
        console.log('cannot test while server already running');
        break;
      }
      mq.init(sMqStore);
      process.on('SIGINT', mq.quit);
      test();
      break;
    default:
      console.log('invalid command "'+argv[2]+'". use stop or test.');
    }
    return;
  }

  if (aPid) {
    console.log('server already running');
    return;
  }

  mq.init(sMqStore, new RegDb('mqreg'));

  var aServer = net.createServer(function(socket) {
    socket.setNoDelay();
    var aWs = new WsStream(socket);
    var aLink = new mq.Link(aWs);

    aWs.on('data', function(frame, msg) {
      aLink.handleMessage(msg);
    });

    aWs.on('end', function(ok) {
      if (!ok) console.log('server got abrupt close');
    });

    socket.on('timeout', function() {
      aLink.timeout();
    });

    socket.on('close', function() {
      aLink.finalize();
    });

    socket.on('error', function(err) {
      switch(err.errno) {
      case process.ENOTCONN:
      case process.ECONNRESET:
      case process.EPIPE:
        console.log('server '+err.message);
        break;
      default:
        throw err;
      }
    });
  });

  fs.writeFileSync(sPid, process.pid.toString());
  process.on('SIGINT', function() {
    fs.unlink(sPid, noop);
    aServer.close();
    mq.quit();
  });

  aServer.listen(8008);
}

function RegDb(iFileName) {
  this.file = iFileName;
  try {
  var aData = fs.readFileSync(this.file, 'ascii');
  } catch (err) {
    if (err.errno !== process.ENOENT) throw err;
  }
  this.db = aData ? JSON.parse(aData) : { uid:{}, alias:{}, list:{} };
}

RegDb.prototype = {

  register: function(iUid, iPassword, iAliases, iCallback, iReReg) {
    var aHas = iUid in this.db.uid;
    if (!iReReg && aHas || iReReg && !aHas)
      var aErr = aHas ? 'user exists' : 'no such user';
    else if (!aHas && !iPassword)
      var aErr = 'password required';
    if (aErr) {
      process.nextTick(function() { iCallback(new Error(aErr)) });
      return;
    }
    if (aHas && iAliases && this.db.uid[iUid].aliases)
      for (var a=0; a < this.db.uid[iUid].aliases.length; ++a)
        delete this.db.alias[this.db.uid[iUid].aliases[a]];
    if (!aHas)
      this.db.uid[iUid] = {};
    if (iPassword)
      this.db.uid[iUid].password = iPassword;
    if (iAliases) {
      var aAccept = iAliases.split(/\s+/);
      for (var a=aAccept.length-1; a >= 0; --a) {
        if (aAccept[a].length === 0 || aAccept[a] in this.db.alias)
          aAccept.splice(a, 1);
        else
          this.db.alias[aAccept[a]] = iUid;
      }
      this.db.uid[iUid].aliases = aAccept;
    }
    var that = this;
    fs.writeFileSync(this.file, JSON.stringify(this.db), 'ascii');
    process.nextTick(function() {
      iCallback(null, aAccept && aAccept.join(' '));
    });
  } ,

  reregister: function(iUid, iPassword, iAliases, iCallback) {
    this.register(iUid, iPassword, iAliases, iCallback, true);
  } ,

  verify: function(iUid, iPassword, iCallback) {
    var that = this;
    process.nextTick(function() {
      iCallback(null, iUid in that.db.uid && that.db.uid[iUid].password === iPassword);
    });
  } ,

  lookup: function(iAlias, iCallback) {
    var that = this;
    process.nextTick(function() {
      var aEr = iAlias in that.db.alias ? null : new Error('alias not defined');
      iCallback(aEr, that.db.alias[iAlias]);
    });
  } ,

  listAdd:    function(iName, iBy, iMember, iCallback) { this._listMod('ad', iName, iBy, iMember, iCallback); } ,
  listRemove: function(iName, iBy, iMember, iCallback) { this._listMod('rm', iName, iBy, iMember, iCallback); } ,
  //listRenew:  function(iName, iBy, iMember, iCallback) { this._listMod('nw', iName, iBy, iMember, iCallback); } ,

  _listMod: function(iOp, iName, iBy, iMember, iCallback) {
    var aHasB, aHasM, aHasL = iName in this.db.list;
    if (iOp === 'rm') {
      aHasB = aHasL && iBy in this.db.list[iName];
      aHasM = aHasL && iMember in this.db.list[iName];
    } else {
      aHasB = iBy in (aHasL ? this.db.list[iName] : this.db.uid);
      aHasM = iMember in this.db.uid;
      aHasL = true;
    } /*else if (iOp === 'nw') {
      for (var a in iMember) {
        if (!(a in this.db.uid)) {
          iMember = a;
          break;
        }
        iMember[a] = 1;
      }
      var aHasM = a && iMember !== a;
    }*/

    if (!aHasL || !aHasB || !aHasM) {
      process.nextTick(function() {
        var aEr = (!aHasL ? 'list '+iName : 'uid '+ (!aHasB ? 'by '+iBy : 'member '+iMember)) +' not found';
        iCallback(new Error(aEr));
      });
      return;
    }
    switch (iOp) {
    case 'ad':
      if (!this.db.list[iName])
        this.db.list[iName] = {};
      this.db.list[iName][iBy] = 1;
      this.db.list[iName][iMember] = 1;
      break;
    case 'rm':
      delete this.db.list[iName][iMember];
      for (var any in this.db.list[iName]) break;
      if (!any) delete this.db.list[iName];
      break;
    /*case 'nw':
      this.db.list[iName] = iMember;
      this.db.list[iName][iBy] = 1;
      break;*/
    }
    fs.writeFileSync(this.file, JSON.stringify(this.db), 'ascii');
    process.nextTick(iCallback);
  } ,

  listLookup: function(iName, iBy, iCallback) {
    var aHasL = iName in this.db.list;
    var aHasB = aHasL && iBy in this.db.list[iName];
    if (!aHasL || !aHasB) {
      process.nextTick(function() {
        iCallback(new Error((!aHasL ? 'list '+iName : 'uid '+iBy) +' not found'), iName);
      });
      return;
    }
    var aList = this.db.list[iName];
    process.nextTick(function() {
      iCallback(null, iName, aList);
    });
  }

}

main(process.argv);

function test() {
  var sToList = {
    aabba:true, bbccb:true, ccddc:true, ddeed:true, eeffe:true, ffggf:true, gghhg:true, hhiih:true, iijji:true, jjkkj:true,
    abcde:true, bcdef:true, cdefg:true, defgh:true, efghi:true, fghij:true, ghijk:true, hijlk:true, ijlkm:true, jklmn:true
  };
  var sMsgList = [ 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten' ];
  for (var a=0; a < sMsgList.length; ++a)
    sMsgList[a] = new Buffer(sMsgList[a]);

  function Testconn(iId) {
    this.link = null;
    this.id = iId;
    this.open = false;
    this.recv = {};
    this.ack = [];
    this.ack.length = sMsgList.length;
  }

  Testconn.prototype = {
    send: function(iMsg) {
      var that = this;
      if (!that.open) {
        console.log('on closed conn: '+iMsg);
        return;
      }
      var aLen = iMsg.toString('ascii',0,4);
      if (/^[0-9A-F]/.test(aLen)) {
        var aJsEnd = parseInt(aLen, 16) +4;
        var aReq = JSON.parse(iMsg.toString('ascii', 4, aJsEnd));
        var aBuf = iMsg.length > aJsEnd ? iMsg.toString('ascii', aJsEnd,iMsg.length) : null;
        if (aReq.op === 'deliver') {
          var aT = Date.now() % 10;
          var aLink = that.link;
          setTimeout(function() {
            if (that.link === aLink)
              that.link.handleMessage(mq.makeMsg({op:'ack', type:'ok', id:aReq.id}));
          }, aT*5);
          if (aBuf in that.recv)
            ++that.recv[aBuf];
          else
            that.recv[aBuf] = 1;
          if (that.recv[aBuf] % 20 === 0)
            console.log(that.id+' got 20 '+aBuf);
        } else if (aReq.op === 'ack') {
          ++that.ack[+aReq.id];
        } else
          console.log(sys.inspect(aReq));
      } else
        console.log(iMsg);
    } ,

    connect: function() {
      this.open = true;
      this.link = new mq.Link(this);
      for (var a=0; a < this.ack.length; ++a)
        this.ack[a] = 0;
    } ,

    close: function() {
      var aList = '';
      for (var a=0; a < this.ack.length; ++a)
        aList += ' '+a+':'+this.ack[a];
      console.log(this.id+aList+' ackd');
      this.open = false;
      this.link.finalize();
      this.link = null;
    }
  }

  function testLink(aC, iState) {
    switch (iState) {
    case 0:
      aC.connect();
      aC.link.handleMessage(mq.makeMsg({op:'login', nodeid:aC.id}));
      setTimeout(testLink, (Date.now()%10)*907, aC, iState+1);
      break;
    case  1: case  2: case  3: case  4: case  5: case  6: case  7: case  8: case  9: case 10:
    case 11: case 12: case 13: case 14: case 15: case 16: case 17: case 18: case 19: case 20:
      if (!aC.link)
        break;
      var aTo = {}, aN = Date.now()%20+1;
      for (var a in sToList) { aTo[a] = sToList[a]; if (--aN === 0) break; }
      var aMsg = mq.makeMsg({op:'post', to:sToList, id:(iState%10).toString()}, sMsgList[iState%10]);
      aC.link.handleMessage(aMsg);
      setTimeout(testLink, (Date.now()%10)*807, aC, iState+1);
      break;
    case 21:
      if (!aC.link)
        break;
      aC.close();
      setTimeout(testLink, (Date.now()%30)*1007, aC, 0);
      break;
    }
  }

  for (var a in sToList) {
    setTimeout(function(a){testLink(new Testconn(a), 0)}, 0, a);
  }
}

