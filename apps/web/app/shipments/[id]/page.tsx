// Server wrapper: unwraps route params (async in Next 15) and hands off to
// the client component — which owns fetching, actions and live refresh.

import { ShipmentClient } from './ShipmentClient';

export default async function ShipmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string; photosFailed?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const photosFailed = Number.parseInt(sp.photosFailed ?? '0', 10);
  return (
    <ShipmentClient
      id={id}
      justCreated={sp.created === '1'}
      photosFailed={Number.isFinite(photosFailed) && photosFailed > 0 ? photosFailed : 0}
    />
  );
}
