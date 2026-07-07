import ScanWorkbench from '../components/shared/ScanWorkbench';

export default function IntegratedPage() {
  return (
    <ScanWorkbench
      taskType="integrated"
      title="到派一体"
      description="一次完成到件扫描与派件扫描"
      submitApi="/api/operations/integrated"
      enableExecutionMode
    />
  );
}
