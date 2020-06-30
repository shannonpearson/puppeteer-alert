const puppeteer = require('puppeteer');
require('dotenv').config();

const AWS = require('aws-sdk');
AWS.config.update({ region: 'us-east-1' });

function delay(time) {
  return new Promise(function (resolve) {
    setTimeout(resolve, time);
  });
}

const S3 = new AWS.S3({
  accessKeyId: process.env.ACCESS_KEY_ID,
  secretAccessKey: process.env.SECRET_ACCESS_KEY,
});

(async (event, context, callback) => {
  const BUCKET = 'puppeteer-consulate';
  let browser = null;

  try {
    console.log('Starting puppeteer process.');
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-gpu'],
    });

    let page = await browser.newPage();
    await page.goto('https://www.germany.info/us-en/embassy-consulates/boston');
    await delay(5000); // because the consulate page has a really dumb auto scroll

    const element = await (await page.$('.c-breaking-news--default')).$(
      '.cta__content' // announcement header
    );

    let text;
    let textHasChanged;
    if (element) {
      text = await page.evaluate((element) => element.textContent, element);
      text = text.trim();
      textHasChanged =
        text !==
        'The Consulate General will be closed on July 3rd.The consular and passport section of the German Consulate General Boston is now open to the public in a limited capacity.';
    }

    if (!element || textHasChanged) {
      const header = await page.$('.c-heading--homepage-embassy');
      const screenshot = await header.screenshot({ encoding: 'binary' });
      console.log('screenshot', screenshot);

      const objectKey = Date.now().toString();

      const data = {
        Bucket: BUCKET,
        Key: objectKey,
        Body: screenshot,
        ContentEncoding: 'base64',
        ContentType: 'image/jpeg',
        ACL: 'public-read',
      };

      let message = `~*~GERMAN CONSULATE BOSTON WEBSITE HAS UPDATED~*~\n\n${
        `New text: ${text}` || 'Text not found.'
      }\n\n`;

      const putPromise = S3.putObject(data).promise();
      await putPromise
        .then((data) => {
          console.log('Succesfully uploaded the image!', data);
          const objectUrl = `https://puppeteer-consulate.s3.amazonaws.com/${objectKey}`;
          message += objectUrl;
        })
        .catch((err) => {
          console.log('Error uploading image:', err);
          message += 'There was an error uploading the screenshot.';
        });

      message = message.slice(0, 140);

      const snsTextParams = {
        Message: message /* required */,
        PhoneNumber: '+12033145287',
        MessageAttributes: {
          'AWS.SNS.SMS.SMSType': {
            DataType: 'String',
            StringValue: 'Transactional',
          },
        },
      };

      const publishTextPromise = new AWS.SNS({
        accessKeyId: process.env.ACCESS_KEY_ID,
        secretAccessKey: process.env.SECRET_ACCESS_KEY,
      })
        .publish(snsTextParams)
        .promise();
      await publishTextPromise
        .then(function (data) {
          console.log(`Published SMS: ${JSON.stringify(data)}`);
          console.log(`Message: ${message}`);
        })
        .catch(function (err) {
          console.error('Error publishing SMS:', err, err.stack);
        });
    } else {
      console.log('No changes found.');
    }
  } catch (error) {
    console.log(`Error in alert.js: ${error}`);
    return callback(error);
  } finally {
    if (browser !== null) {
      await browser.close();
    }
  }

  return callback(null, { ok: true });
})({}, {}, () => {
  console.log('done');
});
