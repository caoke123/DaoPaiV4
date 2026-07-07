import { Globe } from 'lucide-react';
import PageHeader from '../components/shared/PageHeader';
import WorkspaceLayout from '../components/workspace/WorkspaceLayout';
import EmptyState from '../components/shared/EmptyState';

export default function BrowserPage() {
  return (
    <WorkspaceLayout>
      <PageHeader
        title="浏览器窗口"
        description="内置浏览器，可直接访问本地执行端管理后台"
      />
      <EmptyState
        icon={<Globe className="w-12 h-12 text-text-tertiary" />}
        title="浏览器功能即将上线"
        description="将支持直接嵌入本地执行套件管理后台，无需切换窗口"
      />
    </WorkspaceLayout>
  );
}
