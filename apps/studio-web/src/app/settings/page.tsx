import { Suspense } from 'react';
import { AppNav } from '../_components/AppNav';
import SettingsClient from './settings-client';
// Suspense wraps the client component because SettingsClient calls useSearchParams() — without
// the boundary, Next 16 static builds fail with "missing Suspense boundary" CSR bailout.
export default function SettingsPage() {
  return <><AppNav /><Suspense fallback={null}><SettingsClient /></Suspense></>;
}
