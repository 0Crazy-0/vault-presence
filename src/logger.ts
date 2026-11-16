import { Notice } from "obsidian";

export class Logger {
  log(message: string, showPopups: boolean): void {
    if (showPopups) {
      new Notice(message);
    }
    console.debug(`discordrpc: ${message}`);
  }

  logIgnoreNoNotice(message: string): void {
    this.log(message, true);
  }
}
