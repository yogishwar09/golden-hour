/**
 * The fleet definition: where every ambulance patrols, what it is, and who
 * crews it.
 *
 * Shared by the seed script, which creates these vehicles, and the simulator,
 * which drives them. One definition means the two can never disagree about how
 * many crews exist or what they are called.
 *
 * Coverage
 * --------
 * Vehicles sit on a grid across the Hyderabad urban area rather than clustered
 * at hospitals. A city ambulance service parks its vehicles where people are,
 * not where hospitals are -- the point is to be near the next emergency, and
 * the hospital is chosen after the patient is aboard.
 *
 * The grid spacing is chosen so that the worst case -- a patient at the exact
 * centre of a cell, as far from every vehicle as it is possible to be -- is
 * still under two kilometres from an ambulance.
 */

import type { AmbulanceType, LatLng } from '@sas/shared';

/**
 * The area served, covering the GHMC core: the old city in the south,
 * Secunderabad and Kompally in the north, Gachibowli and Miyapur in the west,
 * Uppal and LB Nagar in the east.
 */
export const COVERAGE = {
  latMin: 17.28,
  latMax: 17.53,
  lngMin: 78.3,
  lngMax: 78.6,
} as const;

/** Patrol points across the area. 10 x 12 gives a 1.92 km worst case. */
const ROWS = 10;
const COLUMNS = 12;

export const FLEET_SIZE = ROWS * COLUMNS;

const FIRST_NAMES = [
  'Ravi',
  'Srinivas',
  'Mohammed',
  'Venkatesh',
  'Praveen',
  'Syed',
  'Ramesh',
  'Naveen',
  'Kiran',
  'Abdul',
  'Rajesh',
  'Anil',
  'Suresh',
  'Mahesh',
  'Ganesh',
  'Vijay',
  'Arif',
  'Sandeep',
  'Prakash',
  'Karthik',
  'Imran',
  'Deepak',
  'Sunil',
  'Harish',
];

const LAST_NAMES = [
  'Kumar',
  'Reddy',
  'Rao',
  'Sharma',
  'Goud',
  'Yadav',
  'Chary',
  'Naidu',
  'Khan',
  'Ahmed',
  'Verma',
  'Prasad',
  'Shetty',
  'Pillai',
  'Nair',
  'Das',
];

const CREW_FIRST = [
  'Sneha',
  'Ayesha',
  'Kavitha',
  'Divya',
  'Lakshmi',
  'Meera',
  'Priya',
  'Asha',
  'Farhan',
  'Rohit',
  'Sanjay',
  'Anita',
  'Fatima',
  'Swathi',
  'Rahul',
  'Neha',
];

export interface CrewSpec {
  /** Zero-based position in the fleet; drives the vehicle number and email. */
  index: number;
  vehicleNumber: string;
  driverEmail: string;
  driverName: string;
  paramedic: string;
  type: AmbulanceType;
  /** Where this vehicle waits between calls. */
  patrol: LatLng;
}

/**
 * A small deterministic pseudo-random source.
 *
 * Seeded by index so the fleet is identical on every seed run -- a demo that
 * looks different each time is harder to talk about, and a test that depends
 * on vehicle positions would be flaky otherwise.
 */
function jitter(index: number, salt: number): number {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43_758.5453;
  return value - Math.floor(value) - 0.5; // -0.5 .. 0.5
}

/**
 * Vehicle tier for a patrol point.
 *
 * Capable vehicles sit on a checkerboard rather than being scattered. A
 * cardiac, stroke or trauma call may not be given a basic vehicle, so the
 * distance that matters for those is to an *advanced* one -- and scattering
 * left stripes of basic-only cells five kilometres wide. A checkerboard puts an
 * advanced unit diagonally adjacent to every cell.
 *
 * Mobile ICUs and neonatal units take advanced slots, since both out-rank ALS
 * and so still satisfy an advanced call.
 */
function typeFor(row: number, column: number, index: number): AmbulanceType {
  // Two cells in three carry advanced capability. A checkerboard (one in two)
  // still left a four-kilometre reach at the corners, and cardiac, stroke and
  // trauma together are most of what a service is called to.
  if ((row + column) % 3 !== 1) {
    if (index % 23 === 7) return 'NEONATAL';
    if (index % 11 === 5) return 'MICU';
    return 'ALS';
  }
  // The rest carry basic life support, with a few patient transport vehicles
  // for the non-emergency work a real service also runs.
  return index % 17 === 3 ? 'PTV' : 'BLS';
}

/** The whole fleet, in a stable order. */
export function buildFleet(): CrewSpec[] {
  const latStep = (COVERAGE.latMax - COVERAGE.latMin) / ROWS;
  const lngStep = (COVERAGE.lngMax - COVERAGE.lngMin) / COLUMNS;

  const crews: CrewSpec[] = [];

  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      const index = row * COLUMNS + column;

      // Alternate rows are offset by half a cell, so the vehicles sit in a
      // hexagonal arrangement rather than a square one. Hexagonal packing
      // covers a plane with less overlap for the same number of points, so
      // this is both the better coverage and the less obviously generated
      // layout -- a square lattice reads as pins on a grid at city zoom.
      // Centred on the cell rather than shifted off one side: a one-sided
      // stagger pushes odd rows east and leaves a half-cell gap down the
      // western edge of the service area.
      const stagger = row % 2 === 0 ? -0.25 : 0.25;

      const patrol: LatLng = {
        lat: COVERAGE.latMin + latStep * (row + 0.5) + jitter(index, 1) * latStep * 0.45,
        lng:
          COVERAGE.lngMin + lngStep * (column + 0.5 + stagger) + jitter(index, 2) * lngStep * 0.45,
      };

      crews.push({
        index,
        // TG09 is the Hyderabad Central RTO; numbers run in one sequence.
        vehicleNumber: `TG09AB${String(1001 + index).padStart(4, '0')}`,
        // The first crew gets the memorable address, so the demo login works.
        driverEmail: index === 0 ? 'driver@demo.test' : `driver${index + 1}@demo.test`,
        driverName: `${FIRST_NAMES[index % FIRST_NAMES.length]} ${
          LAST_NAMES[(index * 7) % LAST_NAMES.length]
        }`,
        paramedic: `${CREW_FIRST[(index * 5) % CREW_FIRST.length]} ${
          LAST_NAMES[(index * 3) % LAST_NAMES.length]
        }`,
        type: typeFor(row, column, index),
        patrol,
      });
    }
  }

  return crews;
}
