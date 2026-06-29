import { Suspense } from 'react';
import { AppNav } from '../../_components/AppNav';
import { EnrollmentClient } from './enrollment-client';

export default function EnrollmentPage() {
  return <><AppNav /><Suspense fallback={null}><EnrollmentClient /></Suspense></>;
}
