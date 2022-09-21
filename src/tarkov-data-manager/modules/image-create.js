const sharp = require('sharp');

const axios = require('axios');
const { imageFunctions } = require('tarkov-dev-image-generator');

const { uploadToS3 } = require('./upload-s3');
const jobOutput = require('./job-output');
const tarkovChanges = require('./tarkov-changes');

async function createFromSource(sourceImage, id) {
    const itemData = await jobOutput('update-item-cache', './dumps/item_data.json');
    const taskData = await jobOutput('update-quests', './dumps/quest_data.json', false, true);
    console.log(taskData.items)
    let item = itemData[id] || taskData.items[id];
    if (!item) {
        const items = await tarkovChanges.items();
        const en = await tarkovChanges.locale_en();
        if (!items[id] || !en.templates[id])
            return Promise.reject(`Item ${id} not found in item data`);
        item = {
            id: id,
            name: en.templates[id].Name,
            shortName: en.templates[id].ShortName,
            backgroundColor: items[id]._props.BackgroundColor,
            width: items[id]._props.Width,
            height: items[id]._props.Height,
            types: []
        }
    }
    if (item.types.includes('gun')) {
        item.width = item.properties.defaultWidth;
        item.height = item.properties.defaultHeight;
    }
    if (typeof sourceImage === 'string') {
        sourceImage = sharp(sourceImage);
    }
    const imageResults = await Promise.allSettled([
        imageFunctions.createIcon(sourceImage, item).then(result => {return {image: result, type: 'icon'}}),
        imageFunctions.createBaseImage(sourceImage, item).then(result => {return {image: result, type: 'base-image'}}),
        imageFunctions.createGridImage(sourceImage, item).then(result => {return {image: result, type: 'grid-image'}}),
        imageFunctions.createInspectImage(sourceImage, item).then(result => {return {image: result, type: 'image'}}).catch(() => false),
        imageFunctions.create512Image(sourceImage, item).then(result => {return {image: result, type: '512'}}).catch(() => false),
        imageFunctions.create8xImage(sourceImage, item).then(result => {return {image: result, type: '8x'}}).catch(() => false),
    ]);
    const createdImages = [];
    const errors = [];
    for (const result of imageResults) {
        if (result.status === 'rejected') {
            errors.push(result.reason);
        } else {
            createdImages.push(result.value);
        }
    }
    /*if (errors.length > 0) {
        return Promise.reject(errors);
    }*/
    return createdImages.filter(Boolean);
}

async function createAndUploadFromSource(sourceImage, id) {
    const createdImages = await createFromSource(sourceImage, id);
    const uploads = [];
    for (const result of createdImages) { 
        uploads.push(uploadToS3(result.image, result.type, id));
    }
    const uploadResults = await Promise.allSettled(uploads);
    const errors = [];
    for (const uploadResult of uploadResults) {
        if (uploadResult.status === 'rejected') {
            errors.push(uploadResult.reason);
        }
    }
    if (errors.length > 0) {
        return Promise.reject(errors);
    }
    return createdImages.map(img => img.type);
}

async function regenerateFromExisting(id) {
    const itemData = await jobOutput('update-item-cache', './dumps/item_data.json');
    const item = itemData[id];
    if (!item) {
        return Promise.reject(new Error(`Item ${id} not found in processed item data`));
    }
    let regenSource = '8x';
    let sourceUrl = item.image8xLink;
    if (item.image8xLink.includes('unknown-item')) {
        if (item.baseImageLink.includes('unknown-item')) {
            return Promise.reject(new Error(`${item.name} does not have an 8x or base image to regnerate images from`));
        }
        sourceUrl = `https://${process.env.S3_BUCKET}/${id}-base-image.png`;
        regenSource = 'base';
    }
    if (item.types.includes('gun')) {
        item.width = item.properties.defaultWidth;
        item.height = item.properties.defaultHeight;
    }
    const imageData = (await axios({ url: sourceUrl, responseType: 'arraybuffer' })).data;
    const sourceImage = sharp(await sharp(imageData).png().toBuffer());
    const imageJobs = [
        imageFunctions.createIcon(sourceImage, item).then(result => {return {image: result, type: 'icon'}}),
        imageFunctions.createGridImage(sourceImage, item).then(result => {return {image: result, type: 'grid-image'}}),
    ];
    if (regenSource === '8x') {
        imageJobs.push(
            imageFunctions.createInspectImage(sourceImage, item).then(result => {return {image: result, type: 'image'}})
        );
        imageJobs.push(
            imageFunctions.createBaseImage(sourceImage, item).then(result => {return {image: result, type: 'base-image'}})
        );
        imageJobs.push(
            imageFunctions.create512Image(sourceImage, item).then(result => {return {image: result, type: '512'}})
        );
    } else {
        if (await imageFunctions.canCreateInspectImage(sourceImage)) {
            imageJobs.push(
                imageFunctions.createInspectImage(sourceImage, item).then(result => {return {image: result, type: 'image'}})
            );
        }
    }
    const imageResults = await Promise.allSettled(imageJobs);
    const createdImages = [];
    const errors = [];
    for (const result of imageResults) {
        if (result.status === 'rejected') {
            errors.push(result.reason);
        } else {
            createdImages.push(result.value);
        }
    }
    if (errors.length > 0) {
        return Promise.reject(errors);
    }
    errors.length = 0;
    const uploads = [];
    for (const result of createdImages) { 
        uploads.push(uploadToS3(result.image, result.type, id));
    }
    const uploadResults = await Promise.allSettled(uploads);
    for (const uploadResult of uploadResults) {
        if (uploadResult.status === 'rejected') {
            errors.push(uploadResult.reason);
        }
    }
    if (errors.length > 0) {
        return Promise.reject(errors);
    }
    return {images: createdImages.map(img => img.type), source: regenSource};
}

module.exports = {
    createFromSource,
    createAndUploadFromSource,
    regenerateFromExisting
};