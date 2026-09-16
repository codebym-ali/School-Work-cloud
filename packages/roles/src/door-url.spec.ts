import { doorOrigin } from './door-url';

/**
 * These pin the two defects that made this helper necessary: a link copied on the owner door must
 * land on the STAFF door of the SAME school — never the owner door, never another school.
 */
describe('doorOrigin', () => {
  const at = (hostname: string, port = '', protocol = 'https:') => ({ protocol, hostname, port });

  it('swaps the door label on a production host and keeps the school', () => {
    expect(doorOrigin('staff', at('owner.demo.140-245-39-243.sslip.io'))).toBe('https://staff.demo.140-245-39-243.sslip.io');
  });

  it('keeps the school when it is not the demo one — the reason build-time URLs were rejected', () => {
    expect(doorOrigin('staff', at('owner.beaconhouse.schoolworks.com'))).toBe('https://staff.beaconhouse.schoolworks.com');
  });

  it('swaps the port in the dev layout, where doors share a host', () => {
    expect(doorOrigin('staff', at('demo.localhost', '3005', 'http:'))).toBe('http://demo.localhost:3006');
  });

  it('only ever treats the LEADING label as a door', () => {
    // A door word deeper in the host is part of the school or apex and must survive untouched.
    expect(doorOrigin('owner', at('demo.staff.com'))).toBe('https://demo.staff.com');
  });

  it('is correct for a school that is itself named like a door', () => {
    // `owner`/`staff`/`student` are NOT reserved subdomains, so a school may be called `staff`. Its
    // doors are still two-deep with the door label first, so only that label is swapped.
    expect(doorOrigin('staff', at('owner.staff.schoolworks.com'))).toBe('https://staff.staff.schoolworks.com');
  });

  it('leaves an unrecognised layout alone rather than inventing a port', () => {
    expect(doorOrigin('staff', at('localhost', '8080', 'http:'))).toBe('http://localhost:8080');
  });
});
