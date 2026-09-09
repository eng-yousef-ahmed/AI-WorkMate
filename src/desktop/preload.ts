import { contextBridge, ipcRenderer } from "electron";

import type { AIProcessingPolicy } from "../domain/models";
import { CALENDAR_IPC_CHANNELS, MEETINGS_IPC_CHANNELS, STORAGE_IPC_CHANNELS, type CalendarRendererAPI, type MeetingsRendererAPI, type StorageRendererAPI } from "./storage-api";

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
};

contextBridge.exposeInMainWorld("aiWorkMate", { storage: storageApi, calendar: calendarApi, meetings: meetingsApi });
