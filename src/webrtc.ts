import crypto from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import ipaddr from 'ipaddr.js';
import { classes, Message, methods, parseMessage } from 'werift-ice';

interface WebRtcAddress {
  ip: string;
  port: number;
}

// A libp2p WebRTC-direct listen address, e.g. /ip4/1.2.3.4/udp/30333/webrtc-direct/certhash/.../p2p/...
// (only the ip and the udp port are needed to send a STUN binding request)
const WEBRTC_ADDRESS = /^\/ip[46]\/([0-9a-fA-F.:]+)\/udp\/(\d+)\/webrtc-direct(\/|$)/;

// The addresses come from the (untrusted) node, so cap how many are probed
const MAX_ADDRESSES = 20;
const STUN_TIMEOUT = 3_000;
// Like ICE, the request is retransmitted: a listener can set up the connection on the first one and answer a later one
const STUN_RETRANSMIT_INTERVAL = 250;

// libp2p WebRTC-direct uses the same ICE ufrag & password on both sides
const UFRAG_PREFIX = 'libp2p+webrtc+v1/';

/**
 * The public WebRTC-direct addresses among the listen addresses
 */
function getPublicWebRtcAddresses(listenAddresses: string[]): WebRtcAddress[] {
  const addresses = new Map<string, WebRtcAddress>();

  for (const listenAddress of listenAddresses) {
    const [, ip = '', port = ''] = WEBRTC_ADDRESS.exec(listenAddress) ?? [];

    // 'unicast' excludes the loopback, private, CGNAT, link-local, documentation, multicast & reserved ranges
    if (net.isIP(ip) && ipaddr.process(ip).range() === 'unicast' && Number(port) >= 1 && Number(port) <= 65_535) {
      addresses.set(formatAddress({ ip, port: Number(port) }), { ip, port: Number(port) });
    }
  }

  return [...addresses.values()];
}

function formatAddress({ ip, port }: WebRtcAddress): string {
  return net.isIPv6(ip) ? `[${ip}]:${port}` : `${ip}:${port}`;
}

/**
 * A STUN binding request, as sent by a WebRTC-direct client in its ICE connectivity checks (RFC 8445)
 */
function createBindingRequest(): Message {
  const ufrag = `${UFRAG_PREFIX}${crypto.randomBytes(16).toString('hex')}`;

  return new Message(methods.BINDING, classes.REQUEST)
    .setAttribute('USERNAME', `${ufrag}:${ufrag}`)
    .setAttribute('PRIORITY', 0x6e7f1eff)
    .setAttribute('ICE-CONTROLLING', crypto.randomBytes(8).readBigUInt64BE())
    .addMessageIntegrity(Buffer.from(ufrag))
    .addFingerprint();
}

/**
 * Sends a STUN binding request to the address, resolving with whether it answered
 */
function stunCheck({ ip, port }: WebRtcAddress): Promise<boolean> {
  return new Promise((resolve): void => {
    const socket = dgram.createSocket(net.isIPv6(ip) ? 'udp6' : 'udp4');
    const request = createBindingRequest();
    // socket errors (e.g. 'ENETUNREACH' for an ipv6 address, on a runner without ipv6) fail the check too
    const fail = (): void => done(false);
    const send = (): void => {
      try {
        socket.send(request.bytes, port, ip, (error) => error && fail());
      } catch {
        fail();
      }
    };
    const intervalId = setInterval(send, STUN_RETRANSMIT_INTERVAL);
    const timerId = setTimeout(() => done(false), STUN_TIMEOUT);
    let finished = false;

    function done(answered: boolean): void {
      if (finished) {
        return;
      }

      finished = true;
      clearInterval(intervalId);
      clearTimeout(timerId);
      socket.close();
      resolve(answered);
    }

    socket.on('error', fail);

    // anything else than the success response to our request (e.g. from another sender) is ignored
    socket.on('message', (message): void => {
      const response = parseMessage(message);

      if (
        response?.messageMethod === methods.BINDING &&
        response.messageClass === classes.RESPONSE &&
        response.transactionId.equals(request.transactionId)
      ) {
        done(true);
      }
    });

    send();
  });
}

/**
 * Whether this machine has a public ipv6 address, without which the ipv6 addresses can't be probed
 * (e.g. the GitHub-hosted runners don't have one)
 */
function hasPublicIpv6(): boolean {
  return Object.values(os.networkInterfaces())
    .flat()
    .some((info) => info?.family === 'IPv6' && ipaddr.process(info.address).range() === 'unicast');
}

export interface WebRtcCheck {
  // e.g. '1.2.3.4:30333' or '[2001:db8::1]:30333'
  reachable: string[];
  unreachable: string[];
  // the ipv6 ones, if this machine can't probe them
  unchecked: string[];
}

/**
 * Sends a STUN binding request to each public WebRTC-direct address of the node, returning the ones
 * that answered and the ones that didn't (all empty if the node has no public address)
 */
export async function checkWebRtc(listenAddresses: string[]): Promise<WebRtcCheck> {
  const addresses = getPublicWebRtcAddresses(listenAddresses).slice(0, MAX_ADDRESSES);
  const canProbe = hasPublicIpv6() ? () => true : ({ ip }: WebRtcAddress) => !net.isIPv6(ip);
  const results = await Promise.all(
    addresses
      .filter(canProbe)
      .map(async (address) => ({ address: formatAddress(address), answered: await stunCheck(address) }))
  );

  return {
    reachable: results.filter(({ answered }) => answered).map(({ address }) => address),
    unreachable: results.filter(({ answered }) => !answered).map(({ address }) => address),
    unchecked: addresses.filter((address) => !canProbe(address)).map(formatAddress)
  };
}
