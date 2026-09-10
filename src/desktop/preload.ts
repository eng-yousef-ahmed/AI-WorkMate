import { contextBridge, ipcRenderer } from "electron";

import type { AIProcessingPolicy } from "../domain/models";
import { AUTOMATION_IPC_CHANNELS, CALENDAR_IPC_CHANNELS, MEETINGS_IPC_CHANNELS, NOTIFICATIONS_CHANGED_EVENT, NOTIFICATIONS_IPC_CHANNELS, STORAGE_IPC_CHANNELS, TASKS_IPC_CHANNELS, type AutomationRendererAPI, type CalendarRendererAPI, type MeetingsRendererAPI, type NotificationsRendererAPI, type StorageRendererAPI, type TasksRendererAPI } from "./storage-api";

const storageApi: StorageRendererAPI = {
  getSnapshot: () => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.getSnapshot),
  chooseInitialLocation: () => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.chooseInitialLocation),
  prepareLocationChange: () => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.prepareLocationChange),
  confirmLocationChange: (requestId, migrateExistingData) =>
    ipcRenderer.invoke(STORAGE_IPC_CHANNELS.confirmLocationChange, requestId, migrateExistingData),
  openDataFolder: () => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.openDataFolder),
  verifyStorage: () => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.verifyStorage),
  repairStorage: () => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.repairStorage),
  createBackup: () => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.createBackup),
  restoreBackup: () => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.restoreBackup),
  exportMeeting: (meetingId) => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.exportMeeting, meetingId),
  exportOfficeDocument: (meetingId, kind) => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.exportOfficeDocument, meetingId, kind),
  setAiProcessingPolicy: (policy: AIProcessingPolicy) =>
    ipcRenderer.invoke(STORAGE_IPC_CHANNELS.setAiProcessingPolicy, policy),
  syncMicrosoftCalendar: (request) => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.syncMicrosoftCalendar, request),
};

const calendarApi: CalendarRendererAPI = {
  getMicrosoftStatus: () => ipcRenderer.invoke(CALENDAR_IPC_CHANNELS.getMicrosoftStatus),
  beginMicrosoftSignIn: () => ipcRenderer.invoke(CALENDAR_IPC_CHANNELS.beginMicrosoftSignIn),
  completeMicrosoftSignIn: (input) => ipcRenderer.invoke(CALENDAR_IPC_CHANNELS.completeMicrosoftSignIn, input),
  cancelMicrosoftSignIn: () => ipcRenderer.invoke(CALENDAR_IPC_CHANNELS.cancelMicrosoftSignIn),
  disconnectMicrosoft: () => ipcRenderer.invoke(CALENDAR_IPC_CHANNELS.disconnectMicrosoft),
  syncMicrosoftCalendarAuto: () => ipcRenderer.invoke(CALENDAR_IPC_CHANNELS.syncMicrosoftCalendarAuto),
  syncMicrosoftCalendar: (request) => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.syncMicrosoftCalendar, request),
  saveMicrosoftOAuthConfig: (input) => ipcRenderer.invoke(CALENDAR_IPC_CHANNELS.saveMicrosoftOAuthConfig, input),
  getGoogleStatus: () => ipcRenderer.invoke(CALENDAR_IPC_CHANNELS.getGoogleStatus),
  beginGoogleSignIn: () => ipcRenderer.invoke(CALENDAR_IPC_CHANNELS.beginGoogleSignIn),
  completeGoogleSignIn: (input) => ipcRenderer.invoke(CALENDAR_IPC_CHANNELS.completeGoogleSignIn, input),
  cancelGoogleSignIn: () => ipcRenderer.invoke(CALENDAR_IPC_CHANNELS.cancelGoogleSignIn),
  disconnectGoogle: () => ipcRenderer.invoke(CALENDAR_IPC_CHANNELS.disconnectGoogle),
  syncGoogleCalendarAuto: () => ipcRenderer.invoke(CALENDAR_IPC_CHANNELS.syncGoogleCalendarAuto),
  saveGoogleOAuthConfig: (input) => ipcRenderer.invoke(CALENDAR_IPC_CHANNELS.saveGoogleOAuthConfig, input),
};

const tasksApi: TasksRendererAPI = {
  listTasks: (query) => ipcRenderer.invoke(TASKS_IPC_CHANNELS.listTasks, query === undefined ? undefined : { ...query }),
  getTask: (taskId) => ipcRenderer.invoke(TASKS_IPC_CHANNELS.getTask, taskId),
  createTask: (input) => ipcRenderer.invoke(TASKS_IPC_CHANNELS.createTask, input),
  updateTask: (taskId, patch) => ipcRenderer.invoke(TASKS_IPC_CHANNELS.updateTask, taskId, patch),
  setTaskStatus: (taskId, status) => ipcRenderer.invoke(TASKS_IPC_CHANNELS.setTaskStatus, taskId, status),
  listFollowupSuggestions: (meetingId) => ipcRenderer.invoke(TASKS_IPC_CHANNELS.listFollowupSuggestions, meetingId),
  convertFollowup: (followupId) => ipcRenderer.invoke(TASKS_IPC_CHANNELS.convertFollowup, followupId),
};

const meetingsApi: MeetingsRendererAPI = {
  getOverview: () => ipcRenderer.invoke(MEETINGS_IPC_CHANNELS.getOverview),
  getDetail: (meetingId) => ipcRenderer.invoke(MEETINGS_IPC_CHANNELS.getDetail, meetingId),
  getTranscriptContent: (meetingId, transcriptId) =>
    ipcRenderer.invoke(MEETINGS_IPC_CHANNELS.getTranscriptContent, meetingId, transcriptId),
  searchTranscripts: (query, limit) => ipcRenderer.invoke(MEETINGS_IPC_CHANNELS.searchTranscripts, query, limit),
  getAnalysis: (meetingId) => ipcRenderer.invoke(MEETINGS_IPC_CHANNELS.getAnalysis, meetingId),
  getCaptureCapabilities: () => ipcRenderer.invoke(MEETINGS_IPC_CHANNELS.getCaptureCapabilities),
  startCapture: (request) => ipcRenderer.invoke(MEETINGS_IPC_CHANNELS.startCapture, request),
  stopCapture: (meetingId) => ipcRenderer.invoke(MEETINGS_IPC_CHANNELS.stopCapture, meetingId),
  abortCapture: (meetingId, reason) => ipcRenderer.invoke(MEETINGS_IPC_CHANNELS.abortCapture, meetingId, reason),
  listActiveCaptures: () => ipcRenderer.invoke(MEETINGS_IPC_CHANNELS.listActiveCaptures),
  processMeeting: (meetingId, userApprovedForThisRequest) =>
    ipcRenderer.invoke(MEETINGS_IPC_CHANNELS.processMeeting, meetingId, userApprovedForThisRequest === true),
  openLinkedUrl: (meetingId, kind) => ipcRenderer.invoke(MEETINGS_IPC_CHANNELS.openLinkedUrl, meetingId, kind),
  askMeetingHistory: (question, meetingIds) =>
    ipcRenderer.invoke(MEETINGS_IPC_CHANNELS.askMeetingHistory, question, meetingIds === undefined ? undefined : [...meetingIds]),
  listHistory: (filter) => ipcRenderer.invoke(MEETINGS_IPC_CHANNELS.listHistory, filter === undefined ? undefined : { ...filter }),
  getAssistedJoinPlan: (meetingId) => ipcRenderer.invoke(MEETINGS_IPC_CHANNELS.getAssistedJoinPlan, meetingId),
  beginAssistedJoin: (meetingId) => ipcRenderer.invoke(MEETINGS_IPC_CHANNELS.beginAssistedJoin, meetingId),
  getAssistedFlowPlan: (meetingId) => ipcRenderer.invoke(MEETINGS_IPC_CHANNELS.getAssistedFlowPlan, meetingId),
};

const automationApi: AutomationRendererAPI = {
  getPreferences: () => ipcRenderer.invoke(AUTOMATION_IPC_CHANNELS.getPreferences),
  setPreferences: (patch) => ipcRenderer.invoke(AUTOMATION_IPC_CHANNELS.setPreferences, { ...patch }),
  listNotifications: (query) => ipcRenderer.invoke(AUTOMATION_IPC_CHANNELS.listNotifications, query === undefined ? undefined : { ...query }),
  markRead: (notificationId) => ipcRenderer.invoke(AUTOMATION_IPC_CHANNELS.markRead, notificationId),
  runTick: () => ipcRenderer.invoke(AUTOMATION_IPC_CHANNELS.runTick),
};

const notificationsApi: NotificationsRendererAPI = {
  list: () => ipcRenderer.invoke(NOTIFICATIONS_IPC_CHANNELS.list),
  markRead: (notificationId) => ipcRenderer.invoke(NOTIFICATIONS_IPC_CHANNELS.markRead, notificationId),
  markAllRead: () => ipcRenderer.invoke(NOTIFICATIONS_IPC_CHANNELS.markAllRead),
  getSettings: () => ipcRenderer.invoke(NOTIFICATIONS_IPC_CHANNELS.getSettings),
  updateSettings: (input) => ipcRenderer.invoke(NOTIFICATIONS_IPC_CHANNELS.updateSettings, input),
  runAutomationNow: () => ipcRenderer.invoke(NOTIFICATIONS_IPC_CHANNELS.runAutomationNow),
  onChanged: (listener: () => void) => {
    const handler = (): void => listener();
    ipcRenderer.on(NOTIFICATIONS_CHANGED_EVENT, handler);
    return () => {
      ipcRenderer.removeListener(NOTIFICATIONS_CHANGED_EVENT, handler);
    };
  },
};

contextBridge.exposeInMainWorld("aiWorkMate", {
  storage: storageApi,
  calendar: calendarApi,
  meetings: meetingsApi,
  tasks: tasksApi,
  automation: automationApi,
  notifications: notificationsApi,
});
