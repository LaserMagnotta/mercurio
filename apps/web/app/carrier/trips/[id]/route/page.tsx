import { RouteClient } from './RouteClient';

export default async function TripRoutePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ previewShipmentId?: string; previewDropHubId?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const preview =
    sp.previewShipmentId && sp.previewDropHubId
      ? { previewShipmentId: sp.previewShipmentId, previewDropHubId: sp.previewDropHubId }
      : undefined;
  return <RouteClient tripId={id} {...(preview && { preview })} />;
}
