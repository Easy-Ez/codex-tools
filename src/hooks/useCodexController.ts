import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import type {
  AccountSummary,
  AppSettings,
  AddFlow,
  CurrentAuthStatus,
  Notice,
  PendingUpdateInfo,
  SwitchAccountResult,
} from "../types/app";

const REFRESH_MS = 30_000;
const ADD_FLOW_TIMEOUT_MS = 10 * 60_000;
const ADD_FLOW_POLL_MS = 2_500;
const MANUAL_DOWNLOAD_URL = "https://github.com/170-carry/codex-tools/releases/latest";
const DEFAULT_SETTINGS: AppSettings = {
  launchAtStartup: false,
  trayUsageDisplayMode: "remaining",
  launchCodexAfterSwitch: true,
  syncOpencodeOpenaiAuth: false,
};

export function useCodexController() {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [startingAdd, setStartingAdd] = useState(false);
  const [addFlow, setAddFlow] = useState<AddFlow | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdateInfo | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [savingSettings, setSavingSettings] = useState(false);
  const installingUpdateRef = useRef(false);

  const currentCount = useMemo(
    () => accounts.filter((account) => account.isCurrent).length,
    [accounts],
  );

  const loadAccounts = useCallback(async () => {
    const data = await invoke<AccountSummary[]>("list_accounts");
    setAccounts(data);
  }, []);

  const loadSettings = useCallback(async () => {
    const data = await invoke<AppSettings>("get_app_settings");
    setSettings(data);
  }, []);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    setSavingSettings(true);
    try {
      const data = await invoke<AppSettings>("update_app_settings", { patch });
      setSettings(data);
      setNotice({ type: "ok", message: "设置已更新" });
    } catch (error) {
      setNotice({ type: "error", message: `更新设置失败：${String(error)}` });
    } finally {
      setSavingSettings(false);
    }
  }, []);

  const refreshUsage = useCallback(async (quiet = false) => {
    try {
      if (!quiet) {
        setRefreshing(true);
      }
      const data = await invoke<AccountSummary[]>("refresh_all_usage");
      setAccounts(data);
      if (!quiet) {
        setNotice({ type: "ok", message: "用量已刷新" });
      }
    } catch (error) {
      if (!quiet) {
        setNotice({ type: "error", message: `刷新失败：${String(error)}` });
      }
    } finally {
      if (!quiet) {
        setRefreshing(false);
      }
    }
  }, []);

  const restoreAuthAfterAddFlow = useCallback(async () => {
    try {
      await invoke<boolean>("restore_auth_after_add_flow");
    } catch (error) {
      setNotice({ type: "error", message: `恢复原账号失败：${String(error)}` });
    }
  }, []);

  useEffect(() => {
    installingUpdateRef.current = installingUpdate;
  }, [installingUpdate]);

  const installPendingUpdate = useCallback(
    async (knownUpdate?: NonNullable<Awaited<ReturnType<typeof check>>>) => {
      if (installingUpdateRef.current) {
        return;
      }

      setInstallingUpdate(true);
      setUpdateProgress("准备下载更新...");
      try {
        const update = knownUpdate ?? (await check());
        if (!update) {
          setPendingUpdate(null);
          setUpdateDialogOpen(false);
          setNotice({ type: "ok", message: "当前已是最新版本" });
          return;
        }

        let totalBytes = 0;
        let downloadedBytes = 0;
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") {
            totalBytes = event.data.contentLength ?? 0;
            downloadedBytes = 0;
            setUpdateProgress("开始下载更新...");
          } else if (event.event === "Progress") {
            downloadedBytes += event.data.chunkLength;
            if (totalBytes > 0) {
              const percentValue = Math.min(
                100,
                Math.round((downloadedBytes / totalBytes) * 100),
              );
              setUpdateProgress(`下载中 ${percentValue}%`);
            } else {
              setUpdateProgress("下载中...");
            }
          } else if (event.event === "Finished") {
            setUpdateProgress("下载完成，准备安装...");
          }
        });

        setUpdateProgress("安装完成，正在重启...");
        await relaunch();
      } catch (error) {
        setNotice({ type: "error", message: `安装更新失败：${String(error)}` });
        setUpdateProgress(null);
      } finally {
        setInstallingUpdate(false);
      }
    },
    [],
  );

  const checkForAppUpdate = useCallback(
    async (quiet = false) => {
      if (!quiet) {
        setCheckingUpdate(true);
      }
      try {
        const update = await check();
        if (update) {
          setPendingUpdate({
            currentVersion: update.currentVersion,
            version: update.version,
            body: update.body,
            date: update.date,
          });
          setUpdateDialogOpen(true);
          if (!quiet) {
            setNotice({
              type: "info",
              message: `发现新版本 ${update.version}（当前 ${update.currentVersion}），已开始自动下载。`,
            });
          }
          void installPendingUpdate(update);
        } else {
          setPendingUpdate(null);
          setUpdateDialogOpen(false);
          if (!quiet) {
            setNotice({ type: "ok", message: "当前已是最新版本" });
          }
        }
      } catch (error) {
        if (!quiet) {
          setNotice({ type: "error", message: `检查更新失败：${String(error)}` });
        }
      } finally {
        if (!quiet) {
          setCheckingUpdate(false);
        }
      }
    },
    [installPendingUpdate],
  );

  const openManualDownloadPage = useCallback(async () => {
    try {
      await invoke("open_external_url", { url: MANUAL_DOWNLOAD_URL });
    } catch (error) {
      setNotice({ type: "error", message: `打开下载页面失败：${String(error)}` });
    }
  }, []);

  const closeUpdateDialog = useCallback(() => {
    setUpdateDialogOpen(false);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      try {
        await loadSettings();
        await loadAccounts();
        await refreshUsage(true);
        await checkForAppUpdate(true);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void bootstrap();

    const timer = setInterval(() => {
      void refreshUsage(true);
    }, REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [checkForAppUpdate, loadAccounts, loadSettings, refreshUsage]);

  useEffect(() => {
    if (!addFlow) {
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const poll = async () => {
      if (cancelled || inFlight) {
        return;
      }
      inFlight = true;

      try {
        const current = await invoke<CurrentAuthStatus>("get_current_auth_status");
        if (!current.available || !current.fingerprint) {
          return;
        }

        if (current.fingerprint === addFlow.baselineFingerprint) {
          return;
        }

        await invoke<AccountSummary>("import_current_auth_account", { label: null });
        await restoreAuthAfterAddFlow();
        await refreshUsage(true);
        await loadAccounts();

        if (!cancelled) {
          setAddFlow(null);
          setNotice({ type: "ok", message: "授权成功，账号已自动添加并刷新。" });
        }
      } catch (error) {
        await restoreAuthAfterAddFlow();
        if (!cancelled) {
          setAddFlow(null);
          setNotice({ type: "error", message: `自动导入失败：${String(error)}` });
        }
      } finally {
        inFlight = false;
      }
    };

    void poll();

    const timer = setInterval(() => {
      void poll();
    }, ADD_FLOW_POLL_MS);

    const timeoutTimer = setTimeout(() => {
      if (!cancelled) {
        setAddFlow(null);
        void restoreAuthAfterAddFlow();
        setNotice({ type: "error", message: "等待授权超时，请重新点击“添加账号”。" });
      }
    }, ADD_FLOW_TIMEOUT_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      clearTimeout(timeoutTimer);
    };
  }, [addFlow, loadAccounts, refreshUsage, restoreAuthAfterAddFlow]);

  const onStartAddAccount = useCallback(async () => {
    if (addFlow) {
      return;
    }

    setStartingAdd(true);
    try {
      const baseline = await invoke<CurrentAuthStatus>("get_current_auth_status");
      await invoke<void>("launch_codex_login");
      setAddFlow({
        baselineFingerprint: baseline.fingerprint,
      });
      setNotice({
        type: "info",
        message: "已打开登录授权流程，授权成功后将自动添加账号并刷新列表。",
      });
    } catch (error) {
      setNotice({ type: "error", message: `无法启动登录流程：${String(error)}` });
    } finally {
      setStartingAdd(false);
    }
  }, [addFlow]);

  const onCancelAddFlow = useCallback(() => {
    setAddFlow(null);
    void restoreAuthAfterAddFlow();
    setNotice({ type: "info", message: "已取消自动监听。" });
  }, [restoreAuthAfterAddFlow]);

  const onDelete = useCallback(async (account: AccountSummary) => {
    if (!window.confirm(`确认删除账号 ${account.label} 吗？`)) {
      return;
    }

    try {
      await invoke<void>("delete_account", { id: account.id });
      setAccounts((prev) => prev.filter((item) => item.id !== account.id));
      setNotice({ type: "ok", message: "账号已删除" });
    } catch (error) {
      setNotice({ type: "error", message: `删除失败：${String(error)}` });
    }
  }, []);

  const onSwitch = useCallback(
    async (account: AccountSummary) => {
      setSwitchingId(account.id);
      try {
        const result = await invoke<SwitchAccountResult>("switch_account_and_launch", {
          id: account.id,
          workspacePath: null,
          launchCodex: settings.launchCodexAfterSwitch,
        });
        await loadAccounts();

        let baseNotice: Notice;
        if (!settings.launchCodexAfterSwitch) {
          baseNotice = { type: "ok", message: "账号已切换（未自动启动 Codex）。" };
        } else if (result.usedFallbackCli) {
          baseNotice = {
            type: "info",
            message: "账号已切换。未找到本地 Codex.app，已尝试通过 codex app 启动。",
          };
        } else {
          baseNotice = { type: "ok", message: "账号已切换，正在启动 Codex。" };
        }

        if (settings.syncOpencodeOpenaiAuth) {
          if (result.opencodeSyncError) {
            baseNotice = {
              type: "error",
              message: `${baseNotice.message} Opencode 同步失败：${result.opencodeSyncError}`,
            };
          } else if (result.opencodeSynced) {
            baseNotice = {
              ...baseNotice,
              message: `${baseNotice.message} 已同步 Opencode OpenAI 认证。`,
            };
          }
        }

        setNotice(baseNotice);
      } catch (error) {
        setNotice({ type: "error", message: `切换失败：${String(error)}` });
      } finally {
        setSwitchingId(null);
      }
    },
    [loadAccounts, settings.launchCodexAfterSwitch, settings.syncOpencodeOpenaiAuth],
  );

  return {
    accounts,
    loading,
    refreshing,
    startingAdd,
    addFlow,
    switchingId,
    checkingUpdate,
    installingUpdate,
    updateProgress,
    pendingUpdate,
    updateDialogOpen,
    notice,
    settings,
    savingSettings,
    currentCount,
    refreshUsage,
    checkForAppUpdate,
    installPendingUpdate,
    openManualDownloadPage,
    closeUpdateDialog,
    updateSettings,
    onStartAddAccount,
    onCancelAddFlow,
    onDelete,
    onSwitch,
  };
}
