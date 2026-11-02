import { describe, expect, it } from 'vitest';

import { callbackProblem, isPrivateIpv4, isPrivateIpv6, resolveKnownHost } from './guard.js';

describe('isPrivateIpv4', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.0.8',
    '198.18.0.1',
    '192.0.2.1',
    '198.51.100.7',
    '203.0.113.200',
    '224.0.0.1',
    '255.255.255.255',
  ])('%s is not public', (address) => {
    expect(isPrivateIpv4(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '192.0.3.1',
    '198.51.101.1',
    '203.0.112.1',
    '172.15.0.1',
    '172.32.0.1',
    '100.63.0.1',
    '100.128.0.1',
    '169.253.0.1',
    '198.20.0.1',
    '93.184.216.34',
  ])('%s is public', (address) => {
    expect(isPrivateIpv4(address)).toBe(false);
  });

  it('ignores text that is not an IPv4 address', () => {
    expect(isPrivateIpv4('example.com')).toBe(false);
  });
});

describe('isPrivateIpv6', () => {
  it.each([
    '::1',
    '::',
    '[::1]',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'febf::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '::7f00:1',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b::a00:1',
    '2002:7f00:1::',
    '0:0:0:0:0:ffff:7f00:1',
    '::ffff:0:169.254.169.254',
    '::ffff:0:a9fe:a9fe',
    '64:ff9b:1::a9fe:a9fe',
    '64:ff9b:1::',
    '64:ff9b:1:2:3:4:5:6',
    'fec0::1',
    'feff::1',
    'ff02::1',
    'ff00::',
    'ff0e::1:2:3',
  ])('%s is not public', (address) => {
    expect(isPrivateIpv6(address)).toBe(true);
  });

  it.each([
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '64:ff9b::808:808',
    '2002:808:808::',
    '::ffff:0:808:808',
    '64:ff9b:2::1',
    'not-an-address',
  ])('%s is public', (address) => {
    expect(isPrivateIpv6(address)).toBe(false);
  });
});

describe('resolveKnownHost', () => {
  it('knows the names that resolve to private addresses on the public internet', () => {
    expect(resolveKnownHost('localtest.me')).toBe('127.0.0.1');
    expect(resolveKnownHost('a.localtest.me')).toBe('127.0.0.1');
    expect(resolveKnownHost('169.254.169.254.nip.io')).toBe('169.254.169.254');
    expect(resolveKnownHost('10.0.0.5.sslip.io')).toBe('10.0.0.5');
  });

  it.each([
    ['app.127.0.0.1.nip.io', '127.0.0.1'],
    ['127-0-0-1.nip.io', '127.0.0.1'],
    ['169-254-169-254.sslip.io', '169.254.169.254'],
    ['app-10-0-0-1.nip.io', '10.0.0.1'],
    ['a.b-10-0-0-1.nip.io', '10.0.0.1'],
    ['7f000001.nip.io', '127.0.0.1'],
    ['app-a9fea9fe.sslip.io', '169.254.169.254'],
    ['--1.sslip.io', '::1'],
    ['fe80--1.sslip.io', 'fe80::1'],
  ])('reads the address %s encodes: %s', (host, address) => {
    expect(resolveKnownHost(host)).toBe(address);
  });

  it('leaves a name that encodes no address alone', () => {
    expect(resolveKnownHost('nip.io')).toBeUndefined();
    expect(resolveKnownHost('my-app.nip.io')).toBeUndefined();
    expect(resolveKnownHost('300.1.1.1.nip.io')).toBe('300.1.1.1');
  });

  it('knows nothing about other names', () => {
    expect(resolveKnownHost('example.com')).toBeUndefined();
  });
});

describe('callbackProblem', () => {
  it.each([
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest',
    'https://10.0.0.1/x',
    'https://[::1]/x',
    'https://localhost/x',
    'https://printer.local/x',
    'https://db.internal/x',
    'https://app.localhost/x',
    'https://localtest.me/x',
    'https://169.254.169.254.nip.io/x',
    'https://2130706433/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://[::ffff:169.254.169.254]/x',
    'https://[::127.0.0.1]/',
    'https://[64:ff9b::7f00:1]/',
    'https://LOCALHOST./x',
    'https://foo.localhost./x',
    'https://metadata.google.internal./x',
    'https://127.0.0.1.nip.io./x',
    'https://app.127.0.0.1.nip.io/x',
    'https://127-0-0-1.nip.io/x',
    'https://169-254-169-254.sslip.io/x',
    'https://7f000001.nip.io/x',
    'https://[::ffff:0:169.254.169.254]/x',
    'https://[64:ff9b:1::169.254.169.254]/x',
    'https://[64:ff9b::a9fe:a9fe]/x',
    'https://[fec0::1]/x',
    'https://localtest.me./x',
    'https://intranet/x',
    'https://router.lan/x',
    'https://printer.home.arpa/x',
    'https://192.0.2.10/x',
    'https://198.51.100.10/x',
    'https://203.0.113.10/x',
    'https://[ff02::1]/x',
    'https://example.com@127.0.0.1/x',
    'https://0x7f.1/x',
    'http://example.com/x',
    'not a url',
  ])('refuses %s', (url) => {
    expect(callbackProblem(url)).toBeDefined();
  });

  it.each(['https://hooks.example.com/x', 'https://8.8.8.8/x', 'https://example.com:8443/x?y=1'])(
    'accepts %s',
    (url) => {
      expect(callbackProblem(url)).toBeUndefined();
    }
  );
});
