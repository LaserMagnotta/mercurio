// Server wrapper: unwraps route params (async in Next 15) and hands off to
// the client component that owns fetching and the handoff actions.

import { HubOpsClient } from './HubOpsClient';

export default async function HubShipmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <HubOpsClient id={id} />;
}
