// Server wrapper: unwraps route params (async in Next 15) and hands off to
// the client component. This is where the recipient lands from the tracking
// emails — the URL carries only the shipment id, never the claim token.

import { TrackClient } from './TrackClient';

export default async function TrackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TrackClient id={id} />;
}
