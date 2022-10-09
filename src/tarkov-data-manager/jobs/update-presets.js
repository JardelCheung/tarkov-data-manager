const fs = require('fs');
const path = require('path');

const normalizeName = require('../modules/normalize-name');
const { initPresetSize, getPresetSize } = require('../modules/preset-size');
const { connection, query, jobComplete} = require('../modules/db-connection');
const JobLogger = require('../modules/job-logger');
const {alert} = require('../modules/webhook');
const tarkovChanges = require('../modules/tarkov-changes');
const { getTranslations, setLocales } = require('../modules/get-translation');
const remoteData = require('../modules/remote-data');

let logger = false;

module.exports = async (externalLogger = false) => {
    logger = externalLogger || new JobLogger('update-presets');
    try {
        logger.log('Updating presets');
        const presets = (await tarkovChanges.globals())['ItemPresets'];
        const items = await tarkovChanges.items();
        const en = await tarkovChanges.locale_en();
        const locales = await tarkovChanges.locales();
        const credits = await tarkovChanges.credits();
        const localItems = await remoteData.get();

        setLocales(locales);

        initPresetSize(items, credits);

        const manualPresets = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'manual_presets.json')));

        const presetsData = {};

        const defaults = {};

        const ignorePresets = [
            '5a32808386f774764a3226d9'
        ];
        for (const presetId in presets) {
            if (ignorePresets.includes(presetId)) continue;
            const preset = presets[presetId];
            const baseItem = items[preset._items[0]._tpl];
            if (!baseItem) {
                logger.warn(`Found no base item for preset ${preset._name} ${presetId}`);
                continue;
            }
            const firstItem = {
                id: baseItem._id,
                name: en.templates[baseItem._id].Name
            };
            const presetData = {
                id: presetId,
                name: en.templates[baseItem._id].Name,
                shortName: en.templates[baseItem._id].ShortName,
                //description: en.templates[baseItem._id].Description,
                normalized_name: false,
                baseId: firstItem.id,
                width: baseItem._props.Width,
                height: baseItem._props.Height,
                weight: baseItem._props.Weight,
                baseValue: credits[firstItem.id],
                backgroundColor: baseItem._props.BackgroundColor,
                bsgCategoryId: baseItem._parent,
                types: ['preset'],
                default: true,
                containsItems: [{
                    item: firstItem,
                    count: 1
                }],
                locale: {}
            }
            presetData.locale = getTranslations({
                name: ['templates', baseItem._id, 'Name'],
                shortName: ['templates', baseItem._id, 'ShortName']
            }, logger);
            for (let i = 1; i < preset._items.length; i++) {
                const part = preset._items[i];
                const partData = {
                    item: {
                        id: part._tpl,
                        name: en.templates[part._tpl].Name,
                    },
                    count: 1
                };
                if (part.upd && part.upd.StackObjectsCount) {
                    partData.count = part.upd.StackObjectsCount;
                }
                const existingPart = presetData.containsItems.find(part => part.item.id === partData.item.id);
                if (existingPart) {
                    existingPart.count += partData.count;
                } else {
                    presetData.containsItems.push(partData);
                }
            }
            presetData.weight = Math.round(presetData.weight * 100) / 100;
            if (preset._changeWeaponName && en.preset[presetId] && en.preset[presetId].Name) {
                presetData.name += ' '+en.preset[presetId].Name;
                presetData.shortName += ' '+en.preset[presetId].Name;
                presetData.locale = getTranslations({
                    name: (lang) => {
                        return lang.templates[firstItem.id].Name + ' ' + lang.preset[presetId].Name;
                    },
                    shortName: (lang) => {
                        return lang.templates[firstItem.id].ShortName + ' ' + lang.preset[presetId].Name;
                    }
                }, logger);
            }
            if (preset._encyclopedia !== presetData.baseId) {
                presetData.default = false;
            }
            presetData.normalized_name = normalizeName(presetData.name);
            let itemPresetSize = await getPresetSize(presetData, logger);
            if (itemPresetSize) {
                presetData.width = itemPresetSize.width;
                presetData.height = itemPresetSize.height;
                presetData.weight = itemPresetSize.weight;
                presetData.baseValue = itemPresetSize.baseValue;//credits[baseItem._id];
                presetData.ergonomics = itemPresetSize.ergonomics;
                presetData.verticalRecoil = itemPresetSize.verticalRecoil;
                presetData.horizontalRecoil = itemPresetSize.horizontalRecoil;
                presetData.moa = itemPresetSize.moa;
            }
            presetsData[presetId] = presetData;
            if (presetData.default && !defaults[firstItem.id]) {
                defaults[firstItem.id] = presetData;
            } else if (presetData.default) {
                existingDefault = defaults[firstItem.id];
                logger.warn(`Preset ${presetData.name} ${presetId} cannot replace ${existingDefault.name} ${existingDefault.id} as default preset`);
            }
            logger.succeed(`Completed ${presetData.name} preset (${presetData.containsItems.length+1} parts)`);
        }
        // add manual presets
        for (const presetData of manualPresets) {
            const baseItem = items[presetData.baseId];
            presetData.backgroundColor = baseItem._props.BackgroundColor;
            presetData.bsgCategoryId = baseItem._parent;
            presetData.types = ['preset'];

            let itemPresetSize = await getPresetSize(presetData, logger);
            if (itemPresetSize) {
                presetData.width = itemPresetSize.width;
                presetData.height = itemPresetSize.height;
                presetData.weight = itemPresetSize.weight;
                presetData.baseValue = itemPresetSize.baseValue;
                presetData.ergonomics = itemPresetSize.ergonomics;
                presetData.verticalRecoil = itemPresetSize.verticalRecoil;
                presetData.horizontalRecoil = itemPresetSize.horizontalRecoil;
            } else {
                presetData.width = baseItem._props.Width;
                presetData.height = baseItem._props.Height;
                presetData.weight = baseItem._props.Weight;
                presetData.baseValue = credits[baseItem._id];
                presetData.ergonomics = baseItem._props.Ergonomics;
                presetData.verticalRecoil = baseItem._props.RecoilForceUp;
                presetData.horizontalRecoil = baseItem._props.RecoilForceBack;
            }

            presetData.locale = getTranslations({
                name: (lang) => {
                    let appendName = presetData.appendName;
                    if (Array.isArray(appendName)) {
                        appendName = lang;
                        for (const key of presetData.appendName) {
                            appendName = appendName[key];
                        }
                    }
                    return lang.templates[baseItem._id].Name + ' ' + appendName;
                },
                shortName: (lang) => {
                    let appendName = presetData.appendName;
                    if (Array.isArray(appendName)) {
                        appendName = lang;
                        for (const key of presetData.appendName) {
                            appendName = appendName[key];
                        }
                    }
                    return lang.templates[baseItem._id].ShortName + ' ' + appendName;
                }
            }, logger);
            presetData.name = presetData.locale.en.name;
            presetData.shortName = presetData.locale.en.shortName;
            presetData.normalized_name = normalizeName(presetData.name);
            delete presetData.appendName;
            presetsData[presetData.id] = presetData;
            logger.succeed(`Completed ${presetData.name} manual preset (${presetData.containsItems.length+1} parts)`);
        }
        // add dog tag preset
        const bearTag = items['59f32bb586f774757e1e8442'];
        const getDogTagName = lang => {
            return lang.templates[bearTag._id].Name.replace(lang.templates['59f32bb586f774757e1e8442'].ShortName, '').trim().replace(/^\p{Ll}/gu, substr => {
                return substr.toUpperCase();
            });
        };
        presetsData['customdogtags12345678910'] = {
            id: 'customdogtags12345678910',
            name: getDogTagName(locales.en),
            shortName: getDogTagName(locales.en),
            //description: en.templates[baseItem._id].Description,
            normalized_name: normalizeName(getDogTagName(locales.en)),
            baseId: bearTag._id,
            width: bearTag._props.Width,
            height: bearTag._props.Height,
            weight: bearTag._props.Weight,
            baseValue: credits[bearTag._id],
            backgroundColor: bearTag._props.BackgroundColor,
            bsgCategoryId: bearTag._parent,
            types: ['preset', 'no-flea'],
            default: false,
            containsItems: [
                {
                    item: {
                        id: bearTag._id
                    },
                    count: 1
                },
                {
                    item: {
                        id: '59f32c3b86f77472a31742f0'
                    },
                    count: 1
                }
            ],
            locale: getTranslations({name: getDogTagName, shortName: getDogTagName}, logger)
        };

        // check for missing default presets
        for (const [id, item] of localItems.entries()) {
            if (!item.types.includes('gun') || item.types.includes('disabled'))
                continue;
            
            const matchingPresets = [];
            let defaultId = false;
            for (const preset of Object.values(presetsData)) {
                if (preset.baseId !== id)
                    continue;
                
                if (preset.default) {
                    defaultId = preset.id;
                    break;
                }
                matchingPresets.push(preset);
            }
            if (!defaultId) {
                if (matchingPresets.length === 1) {
                    defaultId = matchingPresets[0].id;
                    matchingPresets[0].default = true;
                }
            }
            if (!defaultId && items[item.id]._props.Slots.length > 0) {
                logger.log(`${item.id} ${item.name} missing preset`);
            }
        }

        // add "Default" to the name of default presets to differentiate them from gun names
        for (const presetId in presetsData) {
            const preset = presetsData[presetId];
            if (!preset.default) {
                continue;
            }
            const baseName = preset.containsItems.find(contained => contained.item.id === preset.baseId).item.name;
            if (baseName !== preset.name) {
                continue;
            }
            preset.name = preset.name + ' ' + en.interface.Default;
            preset.normalized_name = normalizeName(preset.name);
            preset.locale = getTranslations({
                name: (lang) => {
                    return lang.templates[preset.baseId].Name + ' ' + lang.interface.Default;
                },
                shortName: (lang) => {
                    return lang.templates[preset.baseId].ShortName + ' ' + lang.interface.Default;
                }
            }, logger);
        }
        logger.log('Updating presets in DB...');
        const queries = [];
        for (const presetId in presetsData) {
            const p = presetsData[presetId];
            queries.push(query(`
                INSERT INTO 
                    item_data (id, name, short_name, normalized_name, properties)
                VALUES (
                    '${p.id}',
                    ${connection.escape(p.name)},
                    ${connection.escape(p.shortName)},
                    ${connection.escape(p.normalized_name)},
                    ${connection.escape(JSON.stringify({backgroundColor: p.backgroundColor}))}
                )
                ON DUPLICATE KEY UPDATE
                    name=${connection.escape(p.name)},
                    short_name=${connection.escape(p.shortName)},
                    normalized_name=${connection.escape(p.normalized_name)},
                    properties=${connection.escape(JSON.stringify({backgroundColor: p.backgroundColor}))}
            `).then(results => {
                if(results.changedRows > 0){
                    logger.log(`${p.name} updated`);
                }
                if(results.insertId !== 0){
                    logger.log(`${p.name} added`);
                }
            }));
            queries.push(query(`INSERT IGNORE INTO types (item_id, type) VALUES (?, ?)`, [p.id, 'preset']).catch(error => {
                logger.error(`Error inerting preset type for ${p.name} ${p.id}`);
                logger.error(error);
            }));
        }

        fs.writeFileSync(path.join(__dirname, '..', 'cache', 'presets.json'), JSON.stringify(presetsData, null, 4));
        await Promise.allSettled(queries);
    } catch (error) {
        logger.error(error);
        alert({
            title: `Error running ${logger.jobName} job`,
            message: error.stack
        });
    }
    logger.end();
    await jobComplete();
    logger = false;
};