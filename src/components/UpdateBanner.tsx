import type { PendingUpdateInfo } from "../types/app";

type UpdateBannerProps = {
  open: boolean;
  pendingUpdate: PendingUpdateInfo | null;
  updateProgress: string | null;
  installingUpdate: boolean;
  onClose: () => void;
  onManualDownload: () => void;
  onRetryAutoDownload: () => void;
};

export function UpdateBanner({
  open,
  pendingUpdate,
  updateProgress,
  installingUpdate,
  onClose,
  onManualDownload,
  onRetryAutoDownload,
}: UpdateBannerProps) {
  if (!open || !pendingUpdate) {
    return null;
  }

  return (
    <div className="updateOverlay" onClick={onClose}>
      <section
        className="updateDialog"
        role="dialog"
        aria-modal="true"
        aria-label="应用更新"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settingsHeader">
          <div>
            <h2>发现新版本 {pendingUpdate.version}</h2>
            <p>当前版本 {pendingUpdate.currentVersion}，已自动开始下载更新。</p>
          </div>
          <button className="iconButton ghost" onClick={onClose} aria-label="关闭更新弹窗" title="关闭">
            <svg className="iconGlyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="m6 6 12 12" />
              <path d="M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="updateText">
          {pendingUpdate.date && <span>发布时间 {pendingUpdate.date}</span>}
          <span>{installingUpdate ? "自动下载中..." : "自动下载已暂停或失败，可手动处理。"}</span>
        </div>

        <div className="updateDialogActions">
          <button className="ghost" onClick={onManualDownload}>
            手动下载
          </button>
          <button className="primary" onClick={onRetryAutoDownload} disabled={installingUpdate}>
            {installingUpdate ? "自动下载中..." : "重新自动下载"}
          </button>
        </div>

        {updateProgress && <p className="updateProgress">{updateProgress}</p>}
        {pendingUpdate.body && <p className="updateBody">{pendingUpdate.body}</p>}
      </section>
    </div>
  );
}
