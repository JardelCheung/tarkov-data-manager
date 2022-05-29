const fs = require('fs');
const path = require('path');

const roundTo = require('round-to');

const dataMaps = require('../modules/data-map');
const {categories, items} = require('../modules/category-map');
const cloudflare = require('../modules/cloudflare');
const remoteData = require('../modules/remote-data');
const { query, jobComplete } = require('../modules/db-connection');
const JobLogger = require('../modules/job-logger');
const {alert} = require('../modules/webhook');
const tarkovChanges = require('../modules/tarkov-changes');
const getItemProperties = require('../modules/get-item-properties');

let bsgItems = false;
let credits = false;
let en = false;
let locales = false;
let traderData = false;
let logger = false;
let bsgCategories = {};

const ignoreCategories = [
    '54009119af1c881c07000029', // Item
    '566162e44bdc2d3f298b4573', // Compound item
    '5661632d4bdc2d903d8b456b', // Stackable item
    '566168634bdc2d144c8b456c', // Searchable item
];

const addCategory = id => {
    if (!id || bsgCategories[id]) return;
    bsgCategories[id] = {
        id: id,
        parent_id: null,
        locale: {}
    };
    if (en.templates[id]) {
        bsgCategories[id].name = en.templates[id].Name
    } else {
        bsgCategories[id].name = bsgItems[id]._name;
    }
    for (const code in locales) {
        const lang = locales[code];
        if (lang.templates[id]) {
            bsgCategories[id].locale[code] = {
                name: lang.templates[id].Name
            };
        } else {
            bsgCategories[id].locale[code] = {
                name: bsgItems[id]._name
            };
        }
    }
    const parentId = bsgItems[id]._parent;
    if (!ignoreCategories.includes(parentId)) {
        bsgCategories[id].parent_id = parentId;
        addCategory(parentId);
    }
};

const camelCase = input => {
    return input.toLowerCase().replace(/-(.)/g, function(match, group1) {
        return group1.toUpperCase();
    });
};

const getTraderMultiplier = (traderId) => {
    const trader = traderData[traderId];
    if (!trader) throw error (`Trader with id ${traderId} not found in traders data`);
    const coeff = Number(trader.loyaltyLevels[0].buy_price_coef);
    return (100-coeff) / 100;
};

const getItemCategory = (id, original) => {
    if (!original) original = id;
    if(!id){
        return original;
    }

    // Check if parent is category
    if(categories[id]){
        return id;
    }

    // Let's traverse
    return getItemCategory(bsgItems[id]._parent, original);
};

const mappingProperties = {
    // 'BlindnessProtection',
    // 'speedPenaltyPercent',
    // 'mousePenalty',
    // 'weaponErgonomicPenalty',
    // 'armorZone',
    // 'ArmorMaterial',
    // 'headSegments',
    'BlocksEarpiece': 'blocksHeadphones',
    // 'DeafStrength',
    'MaxDurability': 'maxDurability',
    'armorClass': 'armorClass',
    'Accuracy': 'accuracyModifier',
    'Recoil': 'recoilModifier',
    'Ergonomics': 'ergonomicsModifier',
    'Weight': 'weight',
    'Width': 'width',
    'Height': 'height',
    'StackMaxSize': 'stackMaxSize',
    'Tracer': 'tracer',
    'TracerColor': 'tracerColor',
    'ammoType': 'ammoType',
    'ProjectileCount': 'projectileCount',
    'Damage': 'damage',
    'ArmorDamage': 'armorDamage',
    'FragmentationChance': 'fragmentationChance',
    'RicochetChance': 'ricochetChance',
    'PenetrationChance': 'penetrationChance',
    'PenetrationPower': 'penetrationPower',
    'ammoAccr': 'accuracy',
    'ammoRec': 'recoil',
    'InitialSpee': 'initialSpeed',
    'Velocity': 'velocity',
    'Loudness': 'loudness',
};

const getGrid = (item) => {
    if(!item._props.Grids){
        return false;
    }

    const gridData = {
        pockets: [],
        totalSize: 0,
    };

    for(const grid of item._props.Grids){
        gridData.totalSize = gridData.totalSize + grid._props.cellsH * grid._props.cellsV;
        gridData.pockets.push({
            height: grid._props.cellsH,
            width: grid._props.cellsV
        });
    }

    return gridData;
};

const addPropertiesToItem = (item) => {
    if (item.types.includes('preset')) return;
    if(!bsgItems[item.id]?._props){
        return;
    }

    for(const propertyKey in mappingProperties){
        if (propertyKey in bsgItems[item.id]?._props == false) {
            continue;
        }
        let propertyValue = bsgItems[item.id]._props[propertyKey];

        if(typeof propertyValue === 'undefined'){
            continue;
        }

        // Skip falsy strings
        // Should be fixed for actual booleans
        if(typeof propertyValue === 'string' && propertyValue === '') {
            continue;
        }

        item[mappingProperties[propertyKey]] = propertyValue;
    }

    const grid = getGrid(bsgItems[item.id]);
    if(grid && grid.totalSize > 0){
        item.hasGrid = true;
    }  
};

module.exports = async () => {
    logger = new JobLogger('update-item-cache');
    try {
        bsgItems = await tarkovChanges.items();
        credits = await tarkovChanges.credits();
        en = await tarkovChanges.locale_en();
        locales = await tarkovChanges.locales();
        traderData = await tarkovChanges.traders();
        const presets = JSON.parse(fs.readFileSync('./cache/presets.json'));
        const globals = await tarkovChanges.globals();
        const itemMap = await remoteData.get(true);
        const itemData = {};
        bsgCategories = {};

        logger.time('price-yesterday-query');
        const avgPriceYesterday = await query(`SELECT
            avg(price) AS priceYesterday,
            item_id
        FROM
            price_data
        WHERE
            timestamp > DATE_SUB(NOW(), INTERVAL 2 DAY)
        AND
            timestamp < DATE_SUB(NOW(), INTERVAL 1 DAY)
        GROUP BY
            item_id`);
        logger.timeEnd('price-yesterday-query');

        logger.time('last-low-price-query');
        const lastKnownPriceData = await query(`SELECT
            price,
            a.timestamp,
            a.item_id
        FROM
            price_data a
        INNER JOIN (
            SELECT
                max(timestamp) as timestamp,
                item_id
            FROM
                price_data
            WHERE
                timestamp > '2021-12-12 01:00:00'
            GROUP BY
                item_id
        ) b
        ON
            a.timestamp = b.timestamp
        GROUP BY
            item_id, timestamp, price;`);
        logger.timeEnd('last-low-price-query');

        logger.time('contained-items-query');
        const containedItems = await query(`SELECT
            *
        FROM
            item_children;`);
        logger.timeEnd('contained-items-query');

        let containedItemsMap = {};

        for (const result of containedItems) {
            if (!containedItemsMap[result.container_item_id]) {
                containedItemsMap[result.container_item_id] = [];
            }

            containedItemsMap[result.container_item_id].push({
                item: result.child_item_id,
                count: result.count,
                attributes: []
            });
        }

        for (const [key, value] of itemMap.entries()) {
            if (value.types.includes('disabled')) continue;
            itemData[key] = {
                ...value
            };

            Reflect.deleteProperty(itemData[key], 'last_update');
            Reflect.deleteProperty(itemData[key], 'last_scan');
            Reflect.deleteProperty(itemData[key], 'checked_out_by');
            Reflect.deleteProperty(itemData[key], 'trader_last_scan');
            Reflect.deleteProperty(itemData[key], 'trader_checked_out_by');
            Reflect.deleteProperty(itemData[key], 'scan_position');
            Reflect.deleteProperty(itemData[key], 'match_index');

            // Only add these if it's allowed on the flea market
            if (!itemData[key].types.includes('no-flea')) {
                let itemPriceYesterday = avgPriceYesterday.find(row => row.item_id === key);

                if (!itemPriceYesterday || itemData[key].avg24hPrice === 0) {
                    itemData[key].changeLast48hPercent = 0;
                } else {
                    const percentOfDayBefore = itemData[key].avg24hPrice / itemPriceYesterday.priceYesterday
                    itemData[key].changeLast48hPercent = roundTo((percentOfDayBefore - 1) * 100, 2);
                }
                itemData[key].changeLast48h = itemData[key].changeLast48hPercent

                if (!itemData[key].lastLowPrice) {
                    let lastKnownPrice = lastKnownPriceData.find(row => row.item_id === key);
                    if (lastKnownPrice) {
                        itemData[key].updated = lastKnownPrice.timestamp;
                        itemData[key].lastLowPrice = lastKnownPrice.price;
                    }
                }
            }

            itemData[key].types = itemData[key].types.map(type => camelCase(type));

            itemData[key].containsItems = containedItemsMap[key];

            // itemData[key].changeLast48h = itemPriceYesterday.priceYesterday || 0;

            if (bsgItems[key]) {
                addPropertiesToItem(itemData[key]);
                itemData[key].basePrice = credits[key];
                itemData[key].bsgCategoryId = bsgItems[key]._parent;
            } else if (presets[key]) {
                const preset = presets[key];
                itemData[key].width = preset.width;
                itemData[key].height = preset.height;
                itemData[key].weight = preset.weight;
                itemData[key].basePrice = preset.baseValue;
                itemData[key].bsgCategoryId = preset.bsgCategoryId;
            } else if (!itemData[key].types.includes('disabled')) {
                logger.log(`No category found for ${itemData[key].name} (${key})`);
            }
            addCategory(itemData[key].bsgCategoryId);

            itemData[key].iconLink = itemData[key].icon_link;
            itemData[key].gridImageLink = itemData[key].grid_image_link;
            itemData[key].imageLink = itemData[key].image_link;
            itemData[key].basePrice = itemData[key].base_price;
            itemData[key].shortName = itemData[key].shortname;
            itemData[key].wikiLink = itemData[key].wiki_link;
            //itemData[key].normalizedName = itemData[key].normalized_name;
            itemData[key].link = `https://tarkov.dev/item/${itemData[key].normalizedName}`;

            itemData[key].discardLimit = -1;
            if (bsgItems[key]) {
                itemData[key].bsgCategoryId = bsgItems[key]._parent;
                itemData[key].discardLimit = bsgItems[key]._props.DiscardLimit;
            }

            // Fallback images
            itemData[key].imageLinkFallback = itemData[key].imageLink || 'https://assets.tarkov.dev/unknown-item-image.jpg';
            itemData[key].iconLinkFallback = itemData[key].iconLink || 'https://assets.tarkov.dev/unknown-item-icon.jpg';
            itemData[key].gridImageLinkFallback = itemData[key].gridImageLink || 'https://assets.tarkov.dev/unknown-item-grid-image.jpg';

            itemData[key].imageLink = itemData[key].imageLink || itemData[key].imageLinkFallback;
            itemData[key].iconLink = itemData[key].iconLink || itemData[key].iconLinkFallback;
            itemData[key].gridImageLink = itemData[key].gridImageLink || itemData[key].gridImageLinkFallback;

            // translations
            itemData[key].locale = {};
            for (const code in locales) {
                const lang = locales[code];
                if (lang.templates[key]) {
                    itemData[key].locale[code] = {
                        name: lang.templates[key].Name,
                        shortName: lang.templates[key].ShortName
                    };
                } else if (presets[key]) {
                    itemData[key].locale[code] = presets[key].locale[code];
                } 
            }

            // Add trader prices
            itemData[key].traderPrices = [];
            const currenciesNow = {
                'RUB': 1,
                'USD': credits['5696686a4bdc2da3298b456a'],
                'EUR': credits['569668774bdc2da2298b4568']
                //'USD': Math.round(credits['5696686a4bdc2da3298b456a'] * 1.1045104510451),
                //'EUR': Math.round(credits['569668774bdc2da2298b4568'] * 1.1530984204131)
            };
            const currencyId = dataMaps.currencyIsoId;
            const traderId = dataMaps.traderNameId;
            
            let sellCategory = false;
            if (bsgItems[key]) {
                sellCategory = getItemCategory(bsgItems[key]._parent);
            }else if (presets[key]) {
                sellCategory = getItemCategory(presets[key].bsgCategoryId)
            } else if (!itemData[key].types.includes('disabled')) {
                logger.log(`No category found for ${itemData[key].name} (${key})`);
            }
            if (sellCategory && categories[sellCategory]){
                for(const trader of categories[sellCategory].traders){
                    let currency = 'RUB';
                    if (trader.name === 'Peacekeeper') currency = 'USD';
                    itemData[key].traderPrices.push({
                        name: trader.name,
                        price: Math.round((getTraderMultiplier(trader.id) * itemData[key].basePrice) / currenciesNow[currency]),
                        currency: currency,
                        currencyItem: currencyId[currency],
                        priceRUB: Math.floor(getTraderMultiplier(trader.id) * itemData[key].basePrice),
                        trader: traderId[trader.name]
                    });
                }
            } else {
                if (itemData[key].types && !itemData[key].types.includes('disabled')) {
                    logger.log(`No category for trader prices mapped for ${itemData[key].name} with category id ${bsgItems[key]._parent}`);
                }
            }

            // Map special items bought by specific vendors
            if(items[key]){
                for(const trader of items[key].traders){
                    let currency = 'RUB';
                    if (trader.name === 'Peacekeeper') currency = 'USD';
                    itemData[key].traderPrices.push({
                        name: trader.name,
                        price: Math.round((getTraderMultiplier(trader.id) * itemData[key].basePrice) / currenciesNow[currency]),
                        currency: currency,
                        currencyItem: currencyId[currency],
                        priceRUB: Math.floor(getTraderMultiplier(trader.id) * itemData[key].basePrice),
                        trader: traderId[trader.name]
                    });
                }
            }
        }

        const fleaData = {
            name: 'Flea Market',
            minPlayerLevel: globals.config.RagFair.minUserLevel,
            enabled: globals.config.RagFair.enabled,
            sellOfferFeeRate: (globals.config.RagFair.communityItemTax / 100),
            sellRequirementFeeRate: (globals.config.RagFair.communityRequirementTax / 100),
            reputationLevels: []
        };
        for (const offerCount of globals.config.RagFair.maxActiveOfferCount) {
            if (fleaData.reputationLevels.length > 0 && fleaData.reputationLevels[fleaData.reputationLevels.length-1].offers == offerCount.count) {
                fleaData.reputationLevels[fleaData.reputationLevels.length-1].maxRep = offerCount.to;
                continue;
            }
            fleaData.reputationLevels.push({
                offers: offerCount.count,
                minRep: offerCount.from,
                maxRep: offerCount.to
            });
        }

        const armorData = {};
        for (const armorTypeId in globals.config.ArmorMaterials) {
            const armorType = globals.config.ArmorMaterials[armorTypeId];
            armorData[armorTypeId] = {
                name: locales.en.interface['Mat'+armorTypeId],
                locale: {}
            };
            for (const key in armorType) {
                armorData[armorTypeId][key.charAt(0).toLocaleLowerCase()+key.slice(1)] = armorType[key];
            }
            armorData[armorTypeId].name = locales.en.interface['Mat'+armorTypeId];
            for (const code in locales) {
                const lang = locales[code];
                if (lang.interface['Mat'+armorTypeId]) {
                    armorData[armorTypeId].locale[code] = {
                        name: lang.interface['Mat'+armorTypeId]
                    };
                }
            }
        }

        const itemsData = {
            updated: new Date(),
            data: itemData,
            categories: bsgCategories,
            flea: fleaData
        };
        const response = await cloudflare(`/values/ITEM_CACHE_V3`, 'PUT', JSON.stringify(itemsData)).catch(error => {
            logger.error(error);
            return {success: false, errors: [], messages: []};
        });
        if (response.success) {
            logger.success('Successful Cloudflare put of ITEM_CACHE');
        } else {
            for (let i = 0; i < response.errors.length; i++) {
                logger.error(response.errors[i]);
            }
            for (let i = 0; i < response.messages.length; i++) {
                logger.error(response.messages[i]);
            }
        }
        fs.writeFileSync(path.join(__dirname, '..', 'dumps', 'item-cache.json'), JSON.stringify(itemsData, null, 4));

        // Possibility to POST to a Discord webhook here with cron status details
    } catch (error) {
        logger.error(error);
        alert({
            title: `Error running ${logger.jobName} job`,
            message: error.toString()
        });
    }
    await jobComplete();
    logger.end();
    bsgItems = credits = en = locales = traderData = bsgCategories = logger = false;
};