import { BoardClient } from './BoardClient';

export default async function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BoardClient tripId={id} />;
}
