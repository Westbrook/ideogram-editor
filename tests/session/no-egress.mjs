// Test-only guard: the entire session campaign may connect only to literal IPv4
// loopback. The production server has no outbound transport implementation.
import { Socket } from 'node:net';
const original = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const value = Array.isArray(args[0]) ? args[0] : args;
  const options = value[0];
  const host = typeof options === 'object' ? (options.host ?? options.hostname) : value[1];
  if (host !== '127.0.0.1') throw new Error('Session test attempted a non-loopback connection.');
  return original.apply(this, args);
};
