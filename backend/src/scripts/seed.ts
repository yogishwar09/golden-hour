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

/** Bengaluru: a dense city centre with enough spread to show real routing. */
const CITY_CENTRE = { lat: 12.9716, lng: 77.5946 };

const HOSPITALS = [
  { name: 'City General Hospital', address: 'Kempegowda Rd, Majestic', lat: 12.9767, lng: 77.5713, traumaLevel: 1, beds: 320, specialties: ['Trauma', 'Cardiology', 'Neurology', 'ICU'] },
  { name: 'Victoria Medical Centre', address: 'Fort Rd, Kalasipalya', lat: 12.9634, lng: 77.5744, traumaLevel: 1, beds: 280, specialties: ['Trauma', 'Burns', 'Orthopaedics'] },
  { name: 'Indiranagar Multispeciality', address: '100 Feet Rd, Indiranagar', lat: 12.9784, lng: 77.6408, traumaLevel: 2, beds: 180, specialties: ['Cardiology', 'Paediatrics', 'Maternity'] },
  { name: 'Koramangala Emergency Care', address: '80 Feet Rd, Koramangala', lat: 12.9352, lng: 77.6245, traumaLevel: 2, beds: 150, specialties: ['Emergency', 'Stroke Unit'] },
  { name: 'Whitefield Community Hospital', address: 'ITPL Main Rd, Whitefield', lat: 12.9698, lng: 77.7500, traumaLevel: 3, beds: 120, specialties: ['Emergency', 'Maternity'] },
  { name: 'Jayanagar Health Institute', address: '4th Block, Jayanagar', lat: 12.9250, lng: 77.5938, traumaLevel: 2, beds: 200, specialties: ['Cardiology', 'Neonatal', 'ICU'] },
  { name: 'Hebbal Trauma Centre', address: 'Bellary Rd, Hebbal', lat: 13.0358, lng: 77.5970, traumaLevel: 1, beds: 240, specialties: ['Trauma', 'Neurosurgery'] },
  { name: 'Electronic City Medicare', address: 'Hosur Rd, Electronic City', lat: 12.8452, lng: 77.6602, traumaLevel: 3, beds: 90, specialties: ['Emergency', 'Occupational Health'] },
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

const FLEET: CrewSpec[] = [
  { vehicleNumber: 'KA01AB1001', type: 'ALS', driverName: 'Ravi Kumar', paramedic: 'Sneha Rao', hospitalIndex: 0, offsetLat: 0.004, offsetLng: 0.006 },
  { vehicleNumber: 'KA01AB1002', type: 'BLS', driverName: 'Imran Shaikh', paramedic: 'Divya Menon', hospitalIndex: 0, offsetLat: -0.008, offsetLng: 0.012 },
  { vehicleNumber: 'KA01AB1003', type: 'MICU', driverName: 'Anil Joseph', paramedic: 'Dr Kavya Nair', hospitalIndex: 1, offsetLat: 0.006, offsetLng: -0.004 },
  { vehicleNumber: 'KA01AB1004', type: 'ALS', driverName: 'Suresh Babu', paramedic: 'Farhan Ali', hospitalIndex: 2, offsetLat: -0.005, offsetLng: -0.010 },
  { vehicleNumber: 'KA01AB1005', type: 'BLS', driverName: 'Manjunath G', paramedic: 'Priya Iyer', hospitalIndex: 3, offsetLat: 0.009, offsetLng: 0.003 },
  { vehicleNumber: 'KA01AB1006', type: 'NEONATAL', driverName: 'Vikram Shetty', paramedic: 'Dr Asha Pillai', hospitalIndex: 5, offsetLat: 0.003, offsetLng: 0.008 },
  { vehicleNumber: 'KA01AB1007', type: 'ALS', driverName: 'Deepak Sharma', paramedic: 'Rohit Verma', hospitalIndex: 6, offsetLat: -0.011, offsetLng: 0.005 },
  { vehicleNumber: 'KA01AB1008', type: 'BLS', driverName: 'Naveen Reddy', paramedic: 'Lakshmi Devi', hospitalIndex: 4, offsetLat: 0.007, offsetLng: -0.013 },
  { vehicleNumber: 'KA01AB1009', type: 'ALS', driverName: 'Arjun Das', paramedic: 'Meera Krishnan', hospitalIndex: 7, offsetLat: -0.004, offsetLng: 0.009 },
  { vehicleNumber: 'KA01AB1010', type: 'PTV', driverName: 'Ganesh Pai', paramedic: 'Sanjay Gupta', hospitalIndex: 1, offsetLat: 0.012, offsetLng: 0.011 },
];

const PATIENTS = [
  { name: 'Aarav Sharma', email: 'patient@demo.test', phone: '+919800000001', bloodGroup: 'O+' as BloodGroup, notes: 'Asthmatic; carries an inhaler.' },
  { name: 'Meera Nair', email: 'meera@demo.test', phone: '+919800000002', bloodGroup: 'A+' as BloodGroup, notes: 'Type 2 diabetes.' },
  { name: 'Rahul Verma', email: 'rahul@demo.test', phone: '+919800000003', bloodGroup: 'B+' as BloodGroup, notes: '' },
];

const EQUIPMENT_BY_TYPE: Record<AmbulanceType, string[]> = {
  PTV: ['Stretcher', 'Oxygen cylinder', 'First aid kit'],
  BLS: ['Stretcher', 'Oxygen cylinder', 'AED', 'Spinal board', 'First aid kit'],
  ALS: ['Stretcher', 'Defibrillator', 'Cardiac monitor', 'Ventilator', 'Drug kit', 'Suction unit'],
  MICU: ['ICU stretcher', 'Ventilator', 'Infusion pumps', 'Defibrillator', 'Blood gas analyser', 'Drug kit'],
  NEONATAL: ['Transport incubator', 'Neonatal ventilator', 'Infusion pumps', 'Warmer', 'Paediatric drug kit'],
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
      location: { type: 'Point' as const, coordinates: [hospital.lng, hospital.lat] as [number, number] },
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
          { name: spec.paramedic, role: spec.type === 'MICU' || spec.type === 'NEONATAL' ? 'Doctor' : 'Paramedic' },
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
    '  Driver             driver@demo.test    (crews KA01AB1001, ALS)',
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
