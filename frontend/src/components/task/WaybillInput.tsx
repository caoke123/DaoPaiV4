// WaybillInput — 运单录入组件
// Phase D-2B: 抽取自 ArrivalPage 的 textarea + 解析 + 预览 + 清空
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { FileText } from 'lucide-react';
import { parseWaybillText, type ParsedWaybills } from '../../lib/waybillParser';

interface WaybillInputProps {
  /** 解析结果变化回调 */
  onParsedChange?: (parsed: ParsedWaybills) => void;
}

/**
 * 运单录入组件
 *
 * 内部管理 textarea 输入 + 防抖解析 + 预览。
 * 通过 onParsedChange 向外暴露解析结果（valid/invalid/totalCount）。
 */
export default function WaybillInput({ onParsedChange }: WaybillInputProps) {
  const [waybillInput, setWaybillInput] = useState('');
  const [debouncedInput, setDebouncedInput] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleInputChange = useCallback((value: string) => {
    setWaybillInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedInput(value);
    }, 300);
  }, []);

  const parsed = useMemo(() => parseWaybillText(debouncedInput), [debouncedInput]);

  useEffect(() => {
    onParsedChange?.(parsed);
  }, [parsed, onParsedChange]);

  const previewValid = parsed.valid.slice(0, 20);
  const previewInvalid = parsed.invalid.slice(0, 10);

  return (
    <div className="grid grid-cols-2 gap-4">
      {/* 录入区 */}
      <div className="bg-surface border border-border rounded-card p-4 shadow-sm flex flex-col">
        <h3 className="text-[14px] font-semibold text-text-primary mb-3">批量运单录入</h3>
        <textarea
          value={waybillInput}
          onChange={(e) => handleInputChange(e.target.value)}
          placeholder="请输入运单号，&#10;支持Excel整列复制后直接粘贴。"
          className="w-full resize-none bg-surface-bg border border-border rounded-input p-3 text-[14px] font-mono text-text-primary placeholder:text-text-tertiary/60 focus:outline-none focus:border-primary transition-colors flex-1"
        />
        <div className="flex items-center justify-between mt-2 text-[12px] text-text-tertiary shrink-0">
          <span>支持换行、Tab、逗号，空格 等分隔</span>
          {waybillInput.trim() && (
            <button
              onClick={() => { setWaybillInput(''); setDebouncedInput(''); }}
              className="text-text-secondary hover:text-danger font-medium transition-colors"
            >
              清空
            </button>
          )}
        </div>
      </div>

      {/* 预览区 */}
      <div className="bg-surface border border-border rounded-card p-4 shadow-sm flex flex-col">
        <h3 className="text-[14px] font-semibold text-text-primary mb-3">运单预览</h3>

        {parsed.totalCount > 0 ? (
          <>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[12px] text-text-tertiary">已识别</span>
              <span className="text-[20px] font-semibold text-success">{parsed.valid.length}</span>
              <span className="text-[12px] text-text-tertiary">条有效运单</span>
              {parsed.invalid.length > 0 && (
                <>
                  <span className="text-[12px] text-text-tertiary">，</span>
                  <span className="text-[20px] font-semibold text-danger">{parsed.invalid.length}</span>
                  <span className="text-[12px] text-text-tertiary">条异常</span>
                </>
              )}
            </div>

            <div className="bg-surface-bg rounded-input p-2 flex-1" style={{ minHeight: '160px', overflowY: 'auto' }}>
              {previewValid.length > 0 && (
                <>
                  <div className="text-[10px] text-text-tertiary mb-1 px-1">有效</div>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {previewValid.map((wb, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center px-2 py-0.5 rounded-full bg-success-light text-success border border-success/20 text-[11px] font-mono"
                      >
                        {wb}
                      </span>
                    ))}
                  </div>
                </>
              )}
              {previewInvalid.length > 0 && (
                <>
                  <div className="text-[10px] text-danger mb-1 px-1">异常（格式不符）</div>
                  <div className="flex flex-wrap gap-1.5">
                    {previewInvalid.map((wb, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center px-2 py-0.5 rounded-full bg-danger-light text-danger border border-danger/20 text-[11px] font-mono"
                        title={`原始值: ${wb}`}
                      >
                        {wb}
                      </span>
                    ))}
                  </div>
                </>
              )}
              {parsed.totalCount > 30 && (
                <div className="text-[11px] text-text-tertiary text-center mt-2">
                  ...共 {parsed.totalCount} 条
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 py-8 text-center">
            <FileText className="w-6 h-6 text-text-tertiary/40 mx-auto mb-2" />
            <p className="text-[13px] text-text-tertiary">请录入运单号</p>
            <p className="text-[11px] text-text-tertiary/60 mt-0.5">系统将自动识别并校验运单</p>
          </div>
        )}
      </div>
    </div>
  );
}
