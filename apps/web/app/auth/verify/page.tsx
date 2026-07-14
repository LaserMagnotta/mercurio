import { Suspense } from 'react';
import { VerifyClient } from './VerifyClient';

// useSearchParams requires a Suspense boundary at build time; the fallback
// is never meaningful (the client resolves immediately).
export default function VerifyPage() {
  return (
    <Suspense fallback={null}>
      <VerifyClient />
    </Suspense>
  );
}
