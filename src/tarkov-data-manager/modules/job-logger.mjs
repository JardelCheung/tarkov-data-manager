import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import { DateTime } from 'luxon';

const writeLog = (jobName, messages) => {
    try {
        fs.mkdirSync(path.join(import.meta.dirname, '..', 'logs'));
    } catch (error) {
        if (error.code !== 'EEXIST') {
            console.log(error);
        }
    }
    try {
        fs.writeFileSync(path.join(import.meta.dirname, '..', 'logs', jobName+'.log'), JSON.stringify(messages, null, 4), {encoding: 'utf8'});
    } catch (error) {
        console.log(`Error writing log file for ${jobName}`, error);
    }
};

class JobLogger {
    constructor(jobName, writeLog = true) {
        this.jobName = jobName;
        this.startTime = DateTime.fromMillis(0);
        this.messages = [];
        this.timers = {};
        this.writeLog = writeLog;
        this.parentLogger = false;
    }

    verbose() {
        return process.env.VERBOSE_LOGS === 'true';
    }

    log(message) {
        if (this.verbose()) console.log(message);
        if (typeof message === 'object') {
            message = JSON.stringify(message, null, 4);
        }
        this.addMessage(message);
    }

    error(message) {
        if (typeof message === 'string') {
            message = chalk.red(message);
        } else if (typeof message === 'object') {
            if (message.stack) {
                message = chalk.red(`${new Date()}`)+'\n'+message.stack;
            } else {
                message = chalk.red(`${new Date()}\n${message.toString()}`);
            }
        }
        if (this.verbose()) console.error(message);
        this.addMessage(message);
    }

    fail(message) {
        this.error(message);
    }

    warn(message) {
        if (typeof message === 'string') {
            message = chalk.yellow(message);
        } else if (typeof message === 'object') {
            message = JSON.stringify(message, null, 4);
        }
        if (this.verbose()) console.warn(message);
        this.addMessage(message);
    }

    succeed(message) {
        if (typeof message === 'string') {
            message = chalk.green(message);
        } else if (typeof message === 'object') {
            message = JSON.stringify(message, null, 4);
        }
        if (this.verbose()) console.log(message);
        this.addMessage(message);
    }

    success(message) {
        this.succeed(message);
    }

    start() {
        this.startTime = DateTime.now();
        if (this.parentLogger) {
            this.messages.push(`Running as child job of ${this.parentLogger.jobName} job`);
        }
    }

    end() {
        const endMessage = `${this.jobName} ended ${DateTime.now().toRelative({ base: this.startTime })}`;
        this.log(endMessage);
        //if (this.verbose()) console.log(endMessage);
        if (this.writeLog) writeLog(this.jobName, this.messages);
        this.messages.length = 0;
        this.startTime = DateTime.fromMillis(0);
        if (this.parentLogger) {
            this.parentLogger = false;
        }
    }

    time(label) {
        this.timers[label] = new Date();
    }

    timeEnd(label) {
        if (!this.timers[label]) return;
        const endMessage = `${label} completed in ${new Date - this.timers[label]}ms`;
        this.log(endMessage);
        delete this.timers[label];
    }

    write(customMessage = false, appendTime = false) {
        if (!customMessage) {
            customMessage = `${this.jobName} ended`;
        }
        if (appendTime) {
            customMessage = `${customMessage} ${DateTime.now().toRelative({ base: this.startTime })}`
        }
        this.log(customMessage);
        writeLog(this.jobName, this.messages);
    }

    addMessage(message) {
        if (this.startTime.toMillis() !== 0 || this.messages.length > 0) {
            // logger is active
            if (this.parentLogger) {
                this.parentLogger.addMessage(message);
            }
            this.messages.push(message);
            return;
        }
        let oldMessages = [];
        try {
            oldMessages = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'logs', this.jobName+'.log')));
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.log(error);
            }
        }
        try {
            oldMessages.push(message);
            writeLog(this.jobName, oldMessages);
        } catch (error) {
            console.log(`Error appending to log file for ${this.jobName}`, error);
        }
    }
}

export default JobLogger;
