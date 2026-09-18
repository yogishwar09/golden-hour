import type { Request, Response } from 'express';
import { haversineMetres, toLatLng, type CreateHospitalInput } from '@sas/shared';
import { Ambulance, Hospital, User } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { recordAudit } from '../services/audit.service.js';
import { realtime } from '../services/realtime.service.js';

interface NearbyQuery {
  lat: number;
  lng: number;
  radiusKm: number;
  limit: number;
}

/** Ambulances near a point, nearest first. Used by the SOS screen's map. */
export const nearbyAmbulances = asyncHandler(async (req: Request, res: Response) => {
  const { lat, lng, radiusKm, limit } = req.query as unknown as NearbyQuery;
  const origin = { lat, lng };

  const vehicles = await Ambulance.find({
    isActive: true,
    status: { $ne: 'OFFLINE' },
    location: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: radiusKm * 1000,
      },
    },
  })
    .limit(limit)
    .populate('hospital', 'name');

  res.json({
    items: vehicles.map((vehicle) => {
      const position = toLatLng(vehicle.location);
      return vehicle.toDto(position ? haversineMetres(origin, position) : undefined);
    }),
  });
});

export const listAmbulances = asyncHandler(async (_req: Request, res: Response) => {
  const vehicles = await Ambulance.find({ isActive: true })
    .populate('driver', 'name phone')
    .populate('hospital', 'name')
    .sort({ vehicleNumber: 1 });
  res.json({ items: vehicles.map((vehicle) => vehicle.toDto()) });
});

export const createAmbulance = asyncHandler(async (req: Request, res: Response) => {
  const input = req.body as {
    vehicleNumber: string;
    type: 'PTV' | 'BLS' | 'ALS' | 'MICU' | 'NEONATAL';
    driverId: string;
    hospitalId: string;
    crew: Array<{ name: string; role: string }>;
    equipment: string[];
    baseLocation: { lat: number; lng: number };
  };

  const [driver, hospital] = await Promise.all([
    User.findById(input.driverId),
    Hospital.findById(input.hospitalId),
  ]);
  if (!driver) throw ApiError.badRequest('That driver account was not found');
  if (driver.role !== 'driver') throw ApiError.badRequest('That account is not a driver account');
  if (!hospital) throw ApiError.badRequest('That hospital was not found');

  const alreadyCrewing = await Ambulance.findOne({ driver: driver._id, isActive: true });
  if (alreadyCrewing) {
    throw ApiError.conflict(`That driver already crews ${alreadyCrewing.vehicleNumber}`);
  }

  const point = { type: 'Point' as const, coordinates: [input.baseLocation.lng, input.baseLocation.lat] as [number, number] };
  const vehicle = await Ambulance.create({
    vehicleNumber: input.vehicleNumber,
    type: input.type,
    driver: driver._id,
    hospital: hospital._id,
    crew: input.crew,
    equipment: input.equipment,
    baseLocation: point,
    // A new vehicle starts parked at its base and off duty.
    location: point,
    status: 'OFFLINE',
  });

  recordAudit({
    actorId: req.user?._id.toString(),
    actorRole: req.user?.role,
    action: 'ambulance.created',
    entityType: 'Ambulance',
    entityId: vehicle._id.toString(),
    meta: { vehicleNumber: vehicle.vehicleNumber },
  });

  res.status(201).json({ ambulance: vehicle.toDto() });
});

export const updateAmbulance = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!id) throw ApiError.badRequest('An ambulance id is required');

  const vehicle = await Ambulance.findById(id);
  if (!vehicle) throw ApiError.notFound('Ambulance not found');

  const input = req.body as Partial<{
    type: 'PTV' | 'BLS' | 'ALS' | 'MICU' | 'NEONATAL';
    status: typeof vehicle.status;
    crew: Array<{ name: string; role: string }>;
    equipment: string[];
    baseLocation: { lat: number; lng: number };
    hospitalId: string;
  }>;

  if (input.status && vehicle.activeRequest && input.status !== vehicle.status) {
    throw ApiError.conflict('This vehicle is on a live case; close the case before changing status');
  }

  if (input.type) vehicle.type = input.type;
  if (input.status) vehicle.status = input.status;
  if (input.crew) vehicle.crew = input.crew;
  if (input.equipment) vehicle.equipment = input.equipment;
  if (input.baseLocation) {
    vehicle.baseLocation = {
      type: 'Point',
      coordinates: [input.baseLocation.lng, input.baseLocation.lat],
    };
  }
  if (input.hospitalId) {
    const hospital = await Hospital.findById(input.hospitalId);
    if (!hospital) throw ApiError.badRequest('That hospital was not found');
    vehicle.hospital = hospital._id;
  }

  await vehicle.save();
  if (input.status) realtime.ambulanceStatus(vehicle._id.toString(), vehicle.status);

  res.json({ ambulance: vehicle.toDto() });
});

/** Soft delete: history referencing this vehicle must remain readable. */
export const retireAmbulance = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!id) throw ApiError.badRequest('An ambulance id is required');

  const vehicle = await Ambulance.findById(id);
  if (!vehicle) throw ApiError.notFound('Ambulance not found');
  if (vehicle.activeRequest) throw ApiError.conflict('This vehicle is on a live case');

  vehicle.isActive = false;
  vehicle.status = 'OUT_OF_SERVICE';
  await vehicle.save();

  recordAudit({
    actorId: req.user?._id.toString(),
    actorRole: req.user?.role,
    action: 'ambulance.retired',
    entityType: 'Ambulance',
    entityId: vehicle._id.toString(),
  });

  res.json({ ok: true });
});

export const listHospitals = asyncHandler(async (_req: Request, res: Response) => {
  const hospitals = await Hospital.find({ isActive: true }).sort({ name: 1 });
  res.json({ items: hospitals.map((hospital) => hospital.toDto()) });
});

export const nearbyHospitals = asyncHandler(async (req: Request, res: Response) => {
  const { lat, lng, radiusKm, limit } = req.query as unknown as NearbyQuery;
  const origin = { lat, lng };

  const hospitals = await Hospital.find({
    isActive: true,
    location: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: radiusKm * 1000,
      },
    },
  }).limit(limit);

  res.json({
    items: hospitals.map((hospital) => {
      const position = toLatLng(hospital.location);
      return hospital.toDto(position ? haversineMetres(origin, position) : undefined);
    }),
  });
});

export const createHospital = asyncHandler(async (req: Request, res: Response) => {
  const input = req.body as CreateHospitalInput;

  const hospital = await Hospital.create({
    name: input.name,
    address: input.address,
    phone: input.phone,
    location: { type: 'Point', coordinates: [input.location.lng, input.location.lat] },
    traumaLevel: input.traumaLevel,
    specialties: input.specialties,
    beds: input.beds,
  });

  recordAudit({
    actorId: req.user?._id.toString(),
    actorRole: req.user?.role,
    action: 'hospital.created',
    entityType: 'Hospital',
    entityId: hospital._id.toString(),
    meta: { name: hospital.name },
  });

  res.status(201).json({ hospital: hospital.toDto() });
});

/**
 * Bed availability, updated by hospital staff. This feeds hospital selection,
 * so a stale count sends patients to a full hospital.
 */
export const updateBeds = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!id) throw ApiError.badRequest('A hospital id is required');

  const hospital = await Hospital.findById(id);
  if (!hospital) throw ApiError.notFound('Hospital not found');

  const input = req.body as { total?: number; available?: number };
  if (input.total !== undefined) hospital.beds.total = input.total;
  if (input.available !== undefined) hospital.beds.available = input.available;

  if (hospital.beds.available > hospital.beds.total) {
    throw ApiError.badRequest('Available beds cannot exceed the total bed count');
  }

  await hospital.save();

  recordAudit({
    actorId: req.user?._id.toString(),
    actorRole: req.user?.role,
    action: 'hospital.beds_updated',
    entityType: 'Hospital',
    entityId: hospital._id.toString(),
    meta: { beds: hospital.beds },
  });

  res.json({ hospital: hospital.toDto() });
});
