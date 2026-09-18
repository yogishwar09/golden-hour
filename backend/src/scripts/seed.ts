/**
 * Seeds a realistic working dataset: hospitals, crews, a fleet, and demo
 * accounts for every role.
 *
 * Safe to re-run. It clears the operational collections first so a demo always
 * starts from a known state, and refuses to touch a production database unless
 * explicitly forced.
 */

import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
  Ambulance,
  AuditLog,
  EmergencyRequest,
  Hospital,
  Notification,
  User,
  hashPassword,
} from '../models/index.js';
import type { AmbulanceType, BloodGroup } from '@sas/shared';

/**
 * Hyderabad. The conventional city point (Abids/Koti), central to the old city,
 * Secunderabad and the western IT corridor alike.
 */
const CITY_CENTRE = { lat: 17.385, lng: 78.4867 };

/**
 * Real Hyderabad hospitals, at their approximate locations, chosen to span the
 * city: the old city, Secunderabad in the north, the Banjara/Jubilee Hills
 * corridor, Gachibowli in the west and LB Nagar in the south-east.
 *
 * Gachibowli sits about 16 km out, which is past the first-pass dispatch radius
 * -- useful, because it exercises the widened second sweep in a demo.
 */
const HOSPITALS = [
  {
    name: 'Osmania General Hospital',
    address: 'Afzal Gunj, Hyderabad',
    lat: 17.3743,
    lng: 78.4751,
    traumaLevel: 1,
    beds: 320,
    specialties: ['Trauma', 'Emergency', 'General Surgery', 'ICU'],
  },
  {
    name: 'Gandhi Hospital',
    address: 'Padmarao Nagar, Secunderabad',
    lat: 17.4295,
    lng: 78.5008,
    traumaLevel: 1,
    beds: 280,
    specialties: ['Trauma', 'Burns', 'Orthopaedics', 'ICU'],
  },
  {
    name: "Nizam's Institute of Medical Sciences",
    address: 'Punjagutta, Hyderabad',
    lat: 17.4256,
    lng: 78.453,
    traumaLevel: 1,
    beds: 240,
    specialties: ['Neurosurgery', 'Cardiology', 'Nephrology', 'ICU'],
  },
  {
    name: 'Yashoda Hospitals',
    address: 'Somajiguda, Hyderabad',
    lat: 17.4252,
    lng: 78.4576,
    traumaLevel: 2,
    beds: 200,
    specialties: ['Cardiology', 'Stroke Unit', 'Oncology'],
  },
  {
    name: 'Apollo Hospitals',
    address: 'Jubilee Hills, Hyderabad',
    lat: 17.4174,
    lng: 78.4118,
    traumaLevel: 2,
    beds: 180,
    specialties: ['Cardiology', 'Transplant', 'Emergency'],
  },
  {
    name: 'KIMS Hospitals',
    address: 'Minister Road, Secunderabad',
    lat: 17.4392,
    lng: 78.4879,
    traumaLevel: 2,
    beds: 190,
    specialties: ['Emergency', 'Cardiology', 'Orthopaedics'],
  },
  {
    name: 'AIG Hospitals',
    address: 'Gachibowli, Hyderabad',
    lat: 17.4222,
    lng: 78.3372,
    traumaLevel: 2,
    beds: 160,
    specialties: ['Gastroenterology', 'Emergency', 'ICU'],
  },
  {
    name: 'Niloufer Hospital for Women and Children',
    address: 'Red Hills, Lakdikapul',
    lat: 17.3933,
    lng: 78.4595,
    traumaLevel: 2,
    beds: 120,
    specialties: ['Neonatal', 'Paediatrics', 'Maternity'],
  },
  {
    name: 'Kamineni Hospitals',
    address: 'LB Nagar, Hyderabad',
    lat: 17.3457,
    lng: 78.551,
    traumaLevel: 3,
    beds: 110,
    specialties: ['Emergency', 'Maternity', 'Orthopaedics'],
  },
];

interface CrewSpec {
  vehicleNumber: string;
  type: AmbulanceType;
  driverName: string;
  paramedic: string;
  hospitalIndex: number;
  /** Offset from the home hospital, so vehicles are spread across the city. */
  offsetLat: number;
  offsetLng: number;
}

/** Telangana registrations; TG09 is the Hyderabad Central (Khairatabad) RTO. */
const FLEET: CrewSpec[] = [
  {
    vehicleNumber: 'TG09AB1001',
    type: 'ALS',
    driverName: 'Ravi Teja',
    paramedic: 'Sneha Reddy',
    hospitalIndex: 0,
    offsetLat: 0.004,
    offsetLng: 0.006,
  },
  {
    vehicleNumber: 'TG09AB1002',
    type: 'BLS',
    driverName: 'Mohammed Imran',
    paramedic: 'Ayesha Begum',
    hospitalIndex: 0,
    offsetLat: -0.008,
    offsetLng: 0.012,
  },
  {
    vehicleNumber: 'TG09AB1003',
    type: 'MICU',
    driverName: 'Srinivas Reddy',
    paramedic: 'Dr Kavitha Rao',
    hospitalIndex: 1,
    offsetLat: 0.006,
    offsetLng: -0.004,
  },
  {
    vehicleNumber: 'TG09AB1004',
    type: 'ALS',
    driverName: 'Venkatesh Rao',
    paramedic: 'Farhan Ahmed',
    hospitalIndex: 2,
    offsetLat: -0.005,
    offsetLng: -0.01,
  },
  {
    vehicleNumber: 'TG09AB1005',
    type: 'BLS',
    driverName: 'Praveen Kumar',
    paramedic: 'Divya Sharma',
    hospitalIndex: 3,
    offsetLat: 0.009,
    offsetLng: 0.003,
  },
  {
    vehicleNumber: 'TG09AB1006',
    type: 'NEONATAL',
    driverName: 'Syed Akbar',
    paramedic: 'Dr Asha Rani',
    hospitalIndex: 7,
    offsetLat: 0.003,
    offsetLng: 0.008,
  },
  {
    vehicleNumber: 'TG09AB1007',
    type: 'ALS',
    driverName: 'Ramesh Goud',
    paramedic: 'Rohit Varma',
    hospitalIndex: 5,
    offsetLat: -0.011,
    offsetLng: 0.005,
  },
  {
    vehicleNumber: 'TG09AB1008',
    type: 'BLS',
    driverName: 'Naveen Chary',
    paramedic: 'Lakshmi Prasanna',
    hospitalIndex: 4,
    offsetLat: 0.007,
    offsetLng: -0.013,
  },
  {
    vehicleNumber: 'TG09AB1009',
    type: 'ALS',
    driverName: 'Kiran Yadav',
    paramedic: 'Meera Joseph',
    hospitalIndex: 8,
    offsetLat: -0.004,
    offsetLng: 0.009,
  },
  {
    vehicleNumber: 'TG09AB1010',
    type: 'PTV',
    driverName: 'Abdul Kareem',
    paramedic: 'Sanjay Goud',
    hospitalIndex: 6,
    offsetLat: 0.012,
    offsetLng: 0.011,
  },
];

const PATIENTS = [
  {
    name: 'Aarav Sharma',
    email: 'patient@demo.test',
    phone: '+919800000001',
    bloodGroup: 'O+' as BloodGroup,
    notes: 'Asthmatic; carries an inhaler.',
  },
  {
    name: 'Fatima Begum',
    email: 'fatima@demo.test',
    phone: '+919800000002',
    bloodGroup: 'A+' as BloodGroup,
    notes: 'Type 2 diabetes.',
  },
  {
    name: 'Rahul Verma',
    email: 'rahul@demo.test',
    phone: '+919800000003',
    bloodGroup: 'B+' as BloodGroup,
    notes: '',
  },
];

const EQUIPMENT_BY_TYPE: Record<AmbulanceType, string[]> = {
  PTV: ['Stretcher', 'Oxygen cylinder', 'First aid kit'],
  BLS: ['Stretcher', 'Oxygen cylinder', 'AED', 'Spinal board', 'First aid kit'],
  ALS: ['Stretcher', 'Defibrillator', 'Cardiac monitor', 'Ventilator', 'Drug kit', 'Suction unit'],
  MICU: [
    'ICU stretcher',
    'Ventilator',
    'Infusion pumps',
    'Defibrillator',
    'Blood gas analyser',
    'Drug kit',
  ],
  NEONATAL: [
    'Transport incubator',
    'Neonatal ventilator',
    'Infusion pumps',
    'Warmer',
    'Paediatric drug kit',
  ],
};

async function seed(): Promise<void> {
  await connectDatabase();

  const usingRealDatabase = Boolean(env.MONGO_URI);
  const forced = process.argv.includes('--force');
  if (usingRealDatabase && env.isProduction && !forced) {
    throw new Error('Refusing to seed a production database. Re-run with --force if you mean it.');
  }

  logger.info('Clearing operational collections');
  await Promise.all([
    User.deleteMany({}),
    Hospital.deleteMany({}),
    Ambulance.deleteMany({}),
    EmergencyRequest.deleteMany({}),
    Notification.deleteMany({}),
    AuditLog.deleteMany({}),
  ]);

  // One hash for every demo account: bcrypt at cost 12 takes ~250ms, and
  // hashing the same string twenty times would make seeding needlessly slow.
  const passwordHash = await hashPassword(env.SEED_PASSWORD);

  const hospitals = await Hospital.insertMany(
    HOSPITALS.map((hospital) => ({
      name: hospital.name,
      address: hospital.address,
      phone: '+918000000000',
      location: {
        type: 'Point' as const,
        coordinates: [hospital.lng, hospital.lat] as [number, number],
      },
      traumaLevel: hospital.traumaLevel,
      specialties: hospital.specialties,
      beds: {
        total: hospital.beds,
        // A plausible mid-shift occupancy rather than an empty hospital.
        available: Math.round(hospital.beds * (0.18 + Math.random() * 0.22)),
      },
    })),
  );
  logger.info({ count: hospitals.length }, 'Hospitals created');

  const admin = await User.create({
    name: 'Control Room Admin',
    email: 'admin@demo.test',
    phone: '+919900000000',
    passwordHash,
    role: 'admin',
    bloodGroup: 'UNKNOWN',
  });

  const hospitalStaff = await User.create({
    name: 'City General Desk',
    email: 'hospital@demo.test',
    phone: '+919900000001',
    passwordHash,
    role: 'hospital',
    bloodGroup: 'UNKNOWN',
  });

  const patients = await User.insertMany(
    PATIENTS.map((patient) => ({
      name: patient.name,
      email: patient.email,
      phone: patient.phone,
      passwordHash,
      role: 'patient' as const,
      bloodGroup: patient.bloodGroup,
      medicalNotes: patient.notes || undefined,
      emergencyContact: { name: 'Family contact', phone: '+919700000000' },
      lastLocation: {
        type: 'Point' as const,
        coordinates: [CITY_CENTRE.lng, CITY_CENTRE.lat] as [number, number],
      },
    })),
  );

  const vehicles = [];
  for (const [index, spec] of FLEET.entries()) {
    const hospital = hospitals[spec.hospitalIndex] ?? hospitals[0];
    if (!hospital) throw new Error('Seed data is inconsistent: no hospitals were created');

    const driver = await User.create({
      // The first driver gets the memorable address so the demo login works.
      email: index === 0 ? 'driver@demo.test' : `driver${index + 1}@demo.test`,
      name: spec.driverName,
      phone: `+9195000000${String(index + 10).padStart(2, '0')}`,
      passwordHash,
      role: 'driver',
      bloodGroup: 'UNKNOWN',
    });

    const [baseLng, baseLat] = hospital.location.coordinates;
    const point = {
      type: 'Point' as const,
      coordinates: [baseLng + spec.offsetLng, baseLat + spec.offsetLat] as [number, number],
    };

    vehicles.push(
      await Ambulance.create({
        vehicleNumber: spec.vehicleNumber,
        type: spec.type,
        // Two vehicles start off duty, so the control room shows a realistic mix.
        status: index >= FLEET.length - 2 ? 'OFFLINE' : 'AVAILABLE',
        driver: driver._id,
        hospital: hospital._id,
        crew: [
          { name: spec.driverName, role: 'Driver' },
          {
            name: spec.paramedic,
            role: spec.type === 'MICU' || spec.type === 'NEONATAL' ? 'Doctor' : 'Paramedic',
          },
        ],
        equipment: EQUIPMENT_BY_TYPE[spec.type],
        baseLocation: point,
        location: point,
        heading: Math.round(Math.random() * 359),
        speedMps: 0,
        lastSeenAt: new Date(),
      }),
    );
  }

  logger.info({ count: vehicles.length }, 'Ambulances created');

  const line = '='.repeat(64);
  const summary = [
    '',
    line,
    '  Seed complete. Demo accounts (all share the same password):',
    line,
    `  Password           ${env.SEED_PASSWORD}`,
    '',
    `  Patient            ${patients[0]?.email ?? 'patient@demo.test'}`,
    '  Driver             driver@demo.test    (crews TG09AB1001, ALS)',
    `  Hospital desk      ${hospitalStaff.email}`,
    `  Control room       ${admin.email}`,
    '',
    `  ${hospitals.length} hospitals, ${vehicles.length} ambulances, ${patients.length} patients`,
    line,
    '',
  ].join('\n');
  // Written straight to stdout so it is readable regardless of log level.
  process.stdout.write(summary);

  await disconnectDatabase();
  await mongoose.disconnect();
}

seed()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'Seeding failed');
    process.exit(1);
  });
