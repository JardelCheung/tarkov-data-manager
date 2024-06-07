import path from 'node:path';
import fs from 'node:fs';

import schedule from 'node-schedule';

const defaultJobs = {
    'update-item-cache': '*/5 * * * *',
    'game-data': '1-59/10 * * * *',
    'update-barters': '2-59/10 * * * *',
    'update-quests': '3-59/10 * * * *',
    'update-maps': '4-59/10 * * * *',
    'check-scanners': '6,36 * * * *',
    'update-td-data': '7-59/10 * * * *',
    'archive-prices': '38 0,12 * * *',
    'verify-wiki': '7 9 * * *',
    'update-trader-assorts': '36 11,23 * * *',
    'update-trader-prices': '46 11,23 * * *',
    'check-image-links': '16 0,6,12,18 * * *',
    'update-quest-images': '16 1,7,13,19 * * *',
    'update-historical-prices': '26 * * * *',
    'update-spt-data': '56 * * * *',
    'update-archived-prices': '38 0 * * *',
    'update-game-status': '*/15 * * * *',
    'start-trader-scan': '30 9,21 * * *',
};

// these jobs only run on the given schedule when not in dev mode
const nonDevJobs = {};

// these jobs run at startup
const startupJobs = [
    'check-image-links',
    'update-tc-data',
    'update-spt-data',
];

// these jobs run at startup when not in dev mode
const nonDevStartupJobs = [];

let allJobs = {
    ...defaultJobs
};
try {
    const customJobs = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'settings', 'crons.json')));
    allJobs = {
        ...defaultJobs,
        ...customJobs
    };
} catch (error) {
    if (error.code !== 'ENOENT') console.log(`Error parsing custom cron jobs`, error);
}
if (process.env.NODE_ENV !== 'dev') {
    allJobs = {
        ...allJobs,
        ...nonDevJobs
    };
}

const jobs = {};
const jobClasses = {};
const scheduledJobs = {};

const jobFiles = fs.readdirSync('./jobs').filter(file => file.endsWith('.mjs'));

for (const file of jobFiles) {
    if (file === 'index.mjs') {
        continue;
    }
    await import(`./${file}`).then(jobClass => {
        jobClasses[file.replace('.mjs', '')] = jobClass.default;
    });
    //const jobClass = require(`./${file}`);
    //jobClasses[file.replace('.mjs', '')] = jobClass;
}

const runJob = async (jobName, options, bumpSchedule = true) => {
    if (!jobs[jobName]) {
        return Promise.reject(new Error(`${jobName} is not a valid job`));
    }
    if (scheduledJobs[jobName]) {
        const scheduledJob = scheduledJobs[jobName];
        const nextInvocation = scheduledJob.nextInvocation();
        if (scheduledJob && bumpSchedule && nextInvocation) {const nextRunMinusFive = nextInvocation.toDate();
            nextRunMinusFive.setMinutes(nextRunMinusFive.getMinutes() - 5);
            if (new Date() > nextRunMinusFive) {
                scheduledJob.cancelNext(true);
            }
        }
        jobs[jobName].nextInvocation = nextInvocation?.toDate();
    }
    return jobs[jobName].start(options);
}

export const jobOutput = async (jobName, parentJob, rawOutput = false) => {
    const job = jobs[jobName];
    if (!job) {
        return Promise.reject(new Error(`Job ${jobName} is not a valid job`));
    }
    const outputFile = `./${job.writeFolder}/${job.kvName}.json`;
    let logger = false;
    if (parentJob && parentJob.logger) {
        logger = parentJob.logger;
    }
    try {
        const json = JSON.parse(fs.readFileSync(outputFile));
        if (!rawOutput) return json[Object.keys(json).find(key => key !== 'updated' && key !== 'locale')];
        return json;
    } catch (error) {
        if (logger) {
            logger.warn(`Output ${outputFile} missing; running ${jobName} job`);
        } else {
            console.log(`Output ${outputFile} missing; running ${jobName} job`);
        }
    }
    return runJob(jobName, {parent: parentJob}).then(result => {
        if (!rawOutput) return result[Object.keys(result).find(key => key !== 'updated')];
        return result;
    });
}

for (const jobClassName in jobClasses) {
    jobs[jobClassName] = new jobClasses[jobClassName]();
    jobs[jobClassName].jobManager = {runJob, jobOutput};
}

const scheduleJob = function(name, cronSchedule) {
    if (!cronSchedule) {
        console.log(`Unscheduling ${name} job`);
        if (scheduledJobs[name]) {
            scheduledJobs[name].cancel();
        }
        return;
    }
    if (!jobs[name]) {
        return;
    }
    console.log(`Setting up ${name} job to run ${cronSchedule}`);

    const job = schedule.scheduleJob(cronSchedule, async () => {
        if (process.env.SKIP_JOBS === 'true') {
            console.log(`Skipping ${name} job`);
            return;
        }
        console.log(`Running ${name} job`);
        console.time(name);
        try {
            await runJob(name, false, false);
        } catch (error) {
            console.log(`Error running ${name} job: ${error}`);
        }
        console.timeEnd(name);
    });
    jobs[name].cronSchedule = cronSchedule;
    if (scheduledJobs[name]) {
        scheduledJobs[name].cancel();
    }
    scheduledJobs[name] = job;
}

const startJobs = async () => {
    // Only run in production
    /*if(process.env.NODE_ENV !== 'production'){
        return true;
    }*/

    for (const jobName in allJobs) {
        try {
            scheduleJob(jobName, allJobs[jobName]);
        } catch (error) {
            console.log(`Error setting up ${jobName} job`, error);
        }
    }

    let allStartupJobs = [...startupJobs];
    if (process.env.NODE_ENV !== 'dev') {
        allStartupJobs = [
            ...startupJobs,
            ...nonDevStartupJobs
        ];
    }
    for (let i = 0; i < allStartupJobs.length; i++) {
        const jobName = allStartupJobs[i];
        if (process.env.SKIP_JOBS === 'true') {
            console.log(`Skipping ${jobName} startup job`);
            continue;
        }
        console.log(`Running ${jobName} job at startup`);
        try {
            await runJob(jobName);
        } catch (error) {
            console.log(`Error running ${jobName}: ${error}`);
        }
    }
    let buildPresets = false;
    try {
        fs.accessSync(path.join(import.meta.dirname, '..', 'cache', 'presets.json'))
    } catch (error) {
        if (error.code === 'ENOENT') {
            buildPresets = true;
        } else {
            console.log(error);
        }
    }
    const promise = new Promise((resolve, reject) => {
        if (!buildPresets) return resolve(true);
        console.log('Running build-presets job at startup');
        runJob('update-presets').finally(() => {
            resolve(true);
        });
    });
    await Promise.allSettled([promise]);
    console.log('Startup jobs complete');
};

const jobManager = {
    start: startJobs,
    stop: () => {
        return schedule.gracefulShutdown();
    },
    schedules: () => {
        const ignoreJobs = [
            'update-hideout-legacy',
            'update-longtime-data',
            'update-quests-legacy',
            'update-queue-times',
            'update-reset-timers',
        ];
        const jobResults = [];
        for (const jobName in jobClasses) {
            if (ignoreJobs.includes(jobName)) {
                continue;
            }
            const jobResult = {
                name: jobName,
                schedule: allJobs[jobName] || '',
                lastRun: false,
                nextRun: false,
                running: jobs[jobName]?.running,
            };
            try {
                const stats = fs.statSync(path.join(import.meta.dirname, '..', 'logs', `${jobName}.log`));
                jobResult.lastRun = stats.mtime;
            } catch (error) {
                if (error.code !== 'ENOENT') console.log(`Error getting ${jobName} last run`, error);
            }
            if (scheduledJobs[jobName]) {
                jobResult.nextRun = scheduledJobs[jobName].nextInvocation();
            }
            jobResults.push(jobResult);
        }
        return jobResults;
    },
    setSchedule: (jobName, cronSchedule) => {
        if (!cronSchedule) {
            cronSchedule = undefined;
        }
        if (cronSchedule === 'default') {
            if (!defaultJobs[jobName]) {
                cronSchedule = undefined;
            } else {
                cronSchedule = defaultJobs[jobName];
            }
        }
        scheduleJob(jobName, cronSchedule);
        allJobs[jobName] = cronSchedule;
        const customJobs = {};
        for (const job in allJobs) {
            if (allJobs[job] !== defaultJobs[job]) {
                customJobs[job] = allJobs[job];
            }
        }
        fs.writeFileSync(path.join(import.meta.dirname, '..', 'settings', 'crons.json'), JSON.stringify(customJobs, null, 4));
    },
    runJob,
    jobOutput,
};

export default jobManager;
