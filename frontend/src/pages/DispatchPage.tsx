import ScanWorkbench from '../components/shared/ScanWorkbench';

export default function DispatchPage() {
  return (
    <ScanWorkbench
      taskType="dispatch"
      title="派件扫描"
      description="自动分配运单并启动派件任务"
      submitApi="/api/operations/dispatch"
      enableExecutionMode
    />
  );
}
