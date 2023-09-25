/**
 * Import necessary Node.js modules and external libraries.
 */
const playwright = require("playwright"); // Playwright for browser automation.
const logger = require("./logger"); // Custom logger module.
const queue = require("./sqs"); // A module for handling a queue.
const isLambda = require("is-lambda"); // A utility to check if running in an AWS Lambda environment.
const chromium = require("@sparticuz/chromium"); // Chromium-related utilities.

/**
 * Retrieve the connection URL from environment variables.
 */
const connectionUrl = process.env.CONNECTION_URL;

/**
 * Create an empty object to store all post data.
 */
let allPosts = {};

/**
 * Define a function to add interceptors to web pages.
 * Intercept specific resource types (images, fonts, stylesheets, scripts, media) and abort them.
 * @param {Page} page - Playwright Page object.
 */
const addPageInterceptors = async (page) => {
  await page.route(/(image|font|stylesheet|script|media)/, (route) => {
    route.abort();
  });
};

/**
 * Define a function to get HTML element attributes.
 * @param {ElementHandle} handle - Playwright ElementHandle object.
 * @returns {Promise<Object>} - Promise resolving to an object containing attribute name-value pairs.
 */
const getAttributes = async (handle) =>
  handle.evaluate((element) => {
    return Array.from(element.attributes).reduce((attributeMap, attr) => {
      attributeMap[attr.name] = attr.value;
      return attributeMap;
    }, {});
  });

/**
 * Define a function to create a new browser instance.
 * @returns {Promise<Browser>} - Promise resolving to a Playwright Browser object.
 */
const newBrowser = async () => {
  const launchOptions = {};

  if (connectionUrl) {
    return playwright.chromium.connectOverCDP(connectionUrl);
  }

  if (isLambda) {
    launchOptions.args = chromium.args;
    launchOptions.executablePath = await chromium.executablePath();
    launchOptions.headless = true; // Always set headless to true in Lambda
  }

  return playwright.chromium.launch(launchOptions);
};

/**
 * Define a function to fetch data for multiple posts concurrently.
 * @param {Array} posts - Array of post objects.
 * @returns {Promise<Array>} - Promise resolving to an array of results from concurrent data fetching.
 */
async function getDataForPostsConcurrently(posts) {
  logger.info("getting data for posts concurrently");

  // Limit the number of concurrent browser instances
  const maxConcurrentBrowsers = 5; // Adjust this number as needed
  const batches = [];

  // Split posts into batches
  for (let i = 0; i < posts.length; i += maxConcurrentBrowsers) {
    const batch = posts.slice(i, i + maxConcurrentBrowsers);
    batches.push(batch);
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const browser = await newBrowser();
      const context = await browser.newContext();
      const page = await context.newPage();
      addPageInterceptors(page);

      const promises = batch.map(async (post) => {
        const data = await getPostData({ page, post });
        const nowStr = new Date().toISOString();
        await queue.publishOne({
          ...data,
          scrapedAt: nowStr,
        });
      });

      await Promise.all(promises);

      // Close the browser and its context after processing the batch
      await context.close();
      await browser.close();
    })
  );

  return results;
}

/**
 * Define a function to fetch data for individual posts.
 * @param {Array} posts - Array of post objects.
 * @param {Page} page - Playwright Page object.
 */
async function getDataForPosts(posts, page) {
  logger.info("getting data for posts");
  let data = [];
  for (const post of posts) {
    let postData = await getPostData({ page, post });
    data.push(postData);
  }

  const nowStr = new Date().toISOString();
  await queue.publish(data.map((post) => ({ ...post, scrapedAt: nowStr })));
}

/**
 * Define a function to parse comments from an ElementHandle representing a comment section.
 * @param {ElementHandle} elementHandle - Playwright ElementHandle object.
 * @returns {Promise<Array>} - Promise resolving to an array of parsed comment objects.
 */
async function parseComment(elementHandle) {
  const things = await elementHandle.$$("> .sitetable > .thing");
  const comments = [];

  for (const thing of things) {
    const attributes = await getAttributes(thing);
    const thingClass = attributes["class"];
    const id = attributes["data-fullname"];

    const childElement = await thing.$(".child");
    const children = childElement ? await parseComment(childElement) : [];

    const isDeleted = thingClass.includes("deleted");
    const isCollapsed = thingClass.includes("collapsed");
    const author = isDeleted ? "" : attributes["data-author"];

    const timeElement = await thing.$("time");
    const time = timeElement ? await timeElement.getAttribute("datetime") : "";

    const mdElement = await thing.$("div.md");
    const comment = mdElement ? await mdElement.innerText() : "";

    const scoreElement = await thing.$("span.score");
    const pointsText = scoreElement ? await scoreElement.innerText() : "";
    const points = parseInt(pointsText.split(" ")[0]) || 0;

    comments.push({
      id,
      author,
      time,
      comment,
      points,
      children,
      isDeleted,
      isCollapsed,
    });
  }

  return comments;
}

/**
 * Define a function to fetch detailed data for a post.
 * @param {Object} options - Options object containing page and post information.
 * @param {Page} options.page - Playwright Page object.
 * @param {Object} options.post - Post object.
 * @returns {Promise<Object>} - Promise resolving to detailed post data.
 */
async function getPostData({ page, post }) {
  logger.info("getting details for post", { post: post.id });

  await page.goto(post.url);

  const sitetable = await page.$("div.sitetable");
  const thing = await sitetable.$(".thing");

  const attributes = await getAttributes(thing);
  const dataType = attributes["data-type"];
  const dataURL = attributes["data-url"];
  const isPromoted = attributes["data-promoted"] === "true";
  const isGallery = attributes["data-gallery"] === "true";

  const title = await page.$eval("a.title", (el) => el.innerText);
  const pointsElement = await sitetable.$(".score.unvoted");
  const points = parseInt((await pointsElement?.innerText) || "0");
  const textElement = await sitetable.$("div.usertext-body");
  const text = textElement ? await textElement.innerText : "";

  let comments = [];
  try {
    const commentArea = await page.$("div.commentarea");
    if (commentArea) {
      comments = await parseComment(commentArea);
    }
  } catch (e) {
    logger.error("error parsing comments", { error: e });
  }

  logger.info("got details for post", { post: post.id });
  delete allPosts[post.id];
  logger.info("number of posts in progress", {
    count: Object.keys(allPosts).length,
  });
  logger.info("remaining posts", { posts: Object.keys(allPosts) });

  return {
    id: post.id,
    subreddit: post.subreddit,
    dataType,
    dataURL,
    isPromoted,
    isGallery,
    title,
    timestamp: post.dt,
    timestamp_millis: post.timestamp,
    author: post.author,
    url: post.url,
    points,
    text,
    comments,
  };
}

/**
 * Define a function to retrieve posts from a web page.
 * @param {Page} page - Playwright Page object.
 * @returns {Promise<Array>} - Promise resolving to an array of post objects.
 */
async function getPostsOnPage(page) {
  logger.info("getting posts for page");

  return await page.$$eval(".thing", (elements) => {
    return elements.map((element) => {
      const attributes = element.dataset;
      const id = attributes.fullname;
      const subreddit = attributes.subredditPrefixed;
      const timestamp = parseInt(attributes.timestamp);
      const dt = new Date(timestamp);
      const author = attributes.author;
      const url = `https://old.reddit.com${attributes.permalink}`;

      return { id, subreddit, dt, timestamp, author, url };
    });
  });
}

/**
 * Define the main function for the script.
 */
async function main() {
  logger.info("launching browser...");
  const browser = await newBrowser();

  logger.info("connecting...");
  const context = await browser.newContext();
  const page = await context.newPage();
  addPageInterceptors(page);

  await page.goto("https://old.reddit.com/r/rust/new/");
  logger.info("connected!");

  const hourInMilliseconds = 60 * 60 * 1000;
  const now = Date.now();
  const cutoff = now - 24 * hourInMilliseconds;
  let earliest = new Date();

  let posts = [];
  while (true) {
    const pagePosts = await getPostsOnPage(page);

    if (pagePosts.length === 0) break;

    posts.push(...pagePosts);

    const earliestPost = pagePosts[pagePosts.length - 1];
    earliest = earliestPost.timestamp;

    if (earliest < cutoff) break;

    const nextPageButton = await page.$(".next-button a");
    if (!nextPageButton) break;

    const nextPageURL = await page.evaluate((el) => el.href, nextPageButton);
    await page.goto(nextPageURL);
  }

  posts = posts.filter((post) => post.timestamp > cutoff);

  if (connectionUrl) {
    await browser.close();
    await getDataForPostsConcurrently(posts);
  } else {
    await getDataForPosts(posts, page);
    await browser.close();
  }

  logger.info(`got ${posts.length} posts`);
}

/**
 * Check if this script is being run as the main module, and if so, execute the main function.
 */
if (require.main === module) {
  main();
}

/**
 * Export an AWS Lambda-compatible handler function.
 * @param {Object} event - AWS Lambda event object.
 * @param {Object} context - AWS Lambda context object.
 * @returns {Promise<Object>} - Promise resolving to a success or error response object.
 */
exports.handler = async function (event, context) {
  try {
    await main();
    return { success: true };
  } catch (e) {
    // Catch and log errors
    console.error(e);
    return { success: false };
  }
};

/**
 * Define a utility function to calculate the size of a web page in bytes.
 * @param {Page} page - Playwright Page object.
 * @returns {Promise<number>} - Promise resolving to the page size in bytes.
 */
const bytesForPage = async (page) => {
  const content = await page.content();
  return Buffer.from(content, "utf8").length;
};
