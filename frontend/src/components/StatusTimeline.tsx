// Legacy wrapper. New code: <Timeline items={requestTimelineItems(tracking.timeline, status)} /> or <ProgressSteps status=… />.
import { Timeline, requestTimelineItems } from './ui/Timeline';
import type { TimelineEvent } from '../lib/types';

export function StatusTimeline({ status, events }: { status: string; events?: TimelineEvent[] }) {
  return <Timeline dense items={requestTimelineItems(events ?? [], status)} />;
}
