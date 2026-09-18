import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Activity, Ambulance, Building2, Clock, MapPin, ShieldCheck, Siren, Zap } from 'lucide-react';

const FEATURES = [
  {
    icon: Zap,
    title: 'Dispatch in seconds',
    body: 'One press sends your location, triage priority and medical notes. The nearest clinically suitable crew is offered the case immediately.',
  },
  {
    icon: MapPin,
    title: 'Watch it arrive',
    body: 'The ambulance moves on your map in real time, with an ETA recalculated from live road conditions rather than a straight line.',
  },
  {
    icon: Activity,
    title: 'Triaged, not queued',
    body: 'Chest pain and a sprained ankle are not the same call. Priority and vehicle capability are decided from what you report.',
  },
  {
    icon: Building2,
    title: 'The hospital is ready',
    body: 'The receiving hospital is chosen by distance, capability and live bed availability, and is told you are coming.',
  },
  {
    icon: ShieldCheck,
    title: 'Accountable by design',
    body: 'Every dispatch decision, status change and cancellation is recorded with who did it and when.',
  },
  {
    icon: Clock,
    title: 'Measured against targets',
    body: 'Response times are tracked against P1-P4 targets, so the service can see where it is slow.',
  },
];

const FLOW = [
  { step: '01', title: 'Press SOS', body: 'Your location and profile go to the dispatcher instantly.' },
  { step: '02', title: 'Nearest crew offered', body: 'The best-placed capable vehicle gets the case; no answer, next crew.' },
  { step: '03', title: 'Track live', body: 'Follow the ambulance on the map with a live ETA.' },
  { step: '04', title: 'Handover', body: 'The crew transports you to a hospital expecting your arrival.' },
];

export function Landing() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex h-20 w-full max-w-7xl items-center justify-between px-6">
        <div className="flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emergency-600 shadow-lg shadow-emergency-900/50">
            <Siren className="h-5 w-5 text-white" aria-hidden />
          </span>
          <span className="text-lg font-extrabold tracking-tight">
            Smart<span className="text-emergency-400">Ambulance</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/login" className="btn-ghost">
            Sign in
          </Link>
          <Link to="/register" className="btn-primary">
            Create account
          </Link>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-6 pb-20 pt-10 sm:pt-16">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="max-w-3xl"
        >
          <span className="chip bg-emergency-500/10 text-emergency-300 ring-1 ring-inset ring-emergency-500/30">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emergency-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emergency-500" />
            </span>
            Real-time emergency dispatch
          </span>

          <h1 className="mt-5 text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-6xl">
            Every minute is
            <br />
            <span className="bg-gradient-to-r from-emergency-400 to-orange-400 bg-clip-text text-transparent">
              a survival rate.
            </span>
          </h1>

          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-300">
            An emergency dispatch system that finds the nearest clinically suitable ambulance,
            routes it over real roads, and lets the patient, the crew, the hospital and the control
            room all watch the same incident unfold.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/register" className="btn-primary px-6 py-3 text-base">
              <Siren className="h-5 w-5" aria-hidden /> Get started
            </Link>
            <Link to="/login" className="btn-secondary px-6 py-3 text-base">
              Sign in to an account
            </Link>
          </div>

          <p className="mt-6 text-sm text-ink-400">
            Demo accounts:{' '}
            <code className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-xs text-ink-200">
              patient@demo.test
            </code>{' '}
            /{' '}
            <code className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-xs text-ink-200">
              admin@demo.test
            </code>{' '}
            with password{' '}
            <code className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-xs text-ink-200">
              Password123
            </code>
          </p>
        </motion.div>
      </section>

      <section className="border-y border-ink-800 bg-ink-900/40">
        <div className="mx-auto grid max-w-7xl gap-px overflow-hidden px-6 py-14 sm:grid-cols-2 lg:grid-cols-4">
          {FLOW.map((item, index) => (
            <motion.div
              key={item.step}
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.08 }}
              className="px-4 py-2"
            >
              <span className="numeric text-2xl font-bold text-emergency-500/70">{item.step}</span>
              <h3 className="mt-2 text-base font-bold text-ink-100">{item.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-400">{item.body}</p>
            </motion.div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-20">
        <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Built the way a dispatch service actually works
        </h2>
        <p className="mt-2 max-w-2xl text-ink-400">
          Not a map with a button on it. The parts that decide who gets sent where, and how fast.
        </p>

        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature, index) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.06 }}
              className="card card-hover p-6"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-emergency-500/10 ring-1 ring-inset ring-emergency-500/20">
                <feature.icon className="h-5 w-5 text-emergency-400" aria-hidden />
              </span>
              <h3 className="mt-4 text-base font-bold text-ink-100">{feature.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-400">{feature.body}</p>
            </motion.div>
          ))}
        </div>
      </section>

      <footer className="border-t border-ink-800 py-10">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-6 sm:flex-row">
          <div className="flex items-center gap-2 text-sm text-ink-400">
            <Ambulance className="h-4 w-4" aria-hidden />
            Smart Emergency Ambulance Dispatch System
          </div>
          <p className="text-center text-xs text-ink-500 sm:text-right">
            A demonstration system. In a real emergency, call your local emergency number.
          </p>
        </div>
      </footer>
    </div>
  );
}
