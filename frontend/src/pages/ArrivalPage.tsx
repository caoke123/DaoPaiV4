import ScanWorkbench from '../components/shared/ScanWorkbench';

export default function ArrivalPage() {
  return (
    <ScanWorkbench
      taskType="arrival"
      title="到件扫描"
      description="批量扫描到件信息，多窗口并发录入"
      submitApi="/api/operations/arrive"
    />
  );
}
