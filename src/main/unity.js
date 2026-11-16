'use strict';
// Talks to the com.papyrus.ide Unity package over a localhost TCP socket.
// Unity writes <project>/Temp/PAPyrus/bridge.json with the port after every domain reload.
const net = require('net');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

class UnityBridge {
  constructor({ root, onMessage, onStatus }) {
    this.root = root;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.socket = null;
    this.port = null;
    this.timer = null;
    this.stopped = false;
    this.info = null;
    this.buf = '';
    this.connecting = false;
    this.lastState = null;
  }

  get bridgeFile() {
    return path.join(this.root, 'Temp', 'PAPyrus', 'bridge.json');
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 1500);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.socket) this.socket.destroy();
    this.socket = null;
  }

  setStatus(state, extra) {
    const key = state + JSON.stringify(extra || {});
    if (key === this.lastState) return;
    this.lastState = key;
    this.onStatus({ state, ...(extra || {}) });
  }

  readInfo() {
    try {
      const info = JSON.parse(fs.readFileSync(this.bridgeFile, 'utf8'));
      if (info.pid && !isAlive(info.pid)) return null;
      return info;
    } catch {
      return null;
    }
  }

  tick() {
    if (this.stopped || this.connecting) return;
    const info = this.readInfo();
    if (!info) {
      if (this.socket) {
        this.socket.destroy();
        this.socket = null;
      }
      const installed = fs.existsSync(path.join(this.root, 'Packages', 'com.papyrus.ide')) || manifestHasPackage(this.root);
      this.setStatus('disconnected', { packageInstalled: installed, isUnityProject: fs.existsSync(path.join(this.root, 'ProjectSettings')) });
      return;
    }
    if (this.socket && this.port === info.port) return;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connect(info);
  }

  connect(info) {
    this.connecting = true;
    this.setStatus('connecting');
    const sock = net.createConnection({ host: '127.0.0.1', port: info.port });
    sock.setNoDelay(true);
    let opened = false;
    // big replies (hierarchy, inspector) arrive in several chunks; a Korean character can be split
    // across two of them, so decode with a StringDecoder instead of chunk.toString()
    const decoder = new StringDecoder('utf8');
    sock.on('connect', () => {
      opened = true;
      this.connecting = false;
      this.socket = sock;
      this.port = info.port;
      this.info = info;
      this.buf = '';
      this.setStatus('connected', { unityVersion: info.unityVersion, projectName: info.projectName, pid: info.pid });
      this.send({ type: 'hello', ide: 'PAPyrus', pid: process.pid });
    });
    sock.on('data', (d) => {
      this.buf += decoder.write(d);
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try {
          this.onMessage(JSON.parse(line));
        } catch { /* ignore malformed */ }
      }
    });
    const closed = () => {
      this.connecting = false;
      if (this.socket === sock) {
        this.socket = null;
        this.port = null;
      }
      if (opened && !this.stopped) this.setStatus('reloading');
    };
    sock.on('error', closed);
    sock.on('close', closed);
  }

  send(obj) {
    if (!this.socket) return false;
    try {
      this.socket.write(JSON.stringify(obj) + '\n');
      return true;
    } catch {
      return false;
    }
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function manifestHasPackage(root) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, 'Packages', 'manifest.json'), 'utf8'));
    return !!(m.dependencies && m.dependencies['com.papyrus.ide']);
  } catch {
    return false;
  }
}

module.exports = { UnityBridge };
