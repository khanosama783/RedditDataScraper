const playwright = require("playwright");
const logger = require("./logger");
const queue = require("./sqs");
const isLambda = require("is-lambda");
const chromium = require("@sparticuz/chromium");

const connectionUrl = process.env.CONNECTION_URL;

let allPosts = {};

const addPageInterceptors = async (page) => {
  await page.route(/(image|font|stylesheet|script|media)/, (route) => {
    route.abort();
  });
};

const getAttributes = async (handle) =>
  handle.evaluate((element) => {
    return Array.from(element.attributes).reduce((attributeMap, attr) => {
      attributeMap[attr.name] = attr.value;
      return attributeMap;
    }, {});
  });

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

if (require.main === module) {
  main();
}

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

const bytesForPage = async (page) => {
  const content = await page.content();
  return Buffer.from(content, "utf8").length;
};
