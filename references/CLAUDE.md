# xint References Guide

## X API Endpoints

### Search
- `GET /2/tweets/search/recent` - Last 7 days, 100 tweets/page
- `GET /2/tweets/search/all` - Full archive (2006+), 500 tweets/page

### User Data
- `GET /2/users/by/username/{username}` - User lookup
- `GET /2/users/me/followers` - Followers list
- `GET /2/users/me/following` - Following list

### Tweet Operations
- `GET /2/tweets/{id}` - Single tweet
- `POST /2/users/me/likes` - Like tweet
- `DELETE /2/users/me/likes/{id}` - Unlike tweet

### User Content
- `GET /2/users/me/bookmarks` - Bookmarks
- `GET /2/users/me/liked_tweets` - Liked tweets

### Trends
- `GET /2/trends/by/woeid/{woeid}` - Trending topics

## Query Operators

| Operator | Example | Description |
|----------|---------|-------------|
| `from:` | `from:elonmusk` | Posts by user |
| `to:` | `to:elonmusk` | Replies to user |
| `#` | `#ai` | Hashtag |
| `$` | `$BTC` | Cashtag |
| `lang:` | `lang:en` | Language filter |
| `is:retweet` | `-is:retweet` | Exclude retweets |
| `is:reply` | `-is:reply` | Exclude replies |
| `has:links` | `has:links` | Has links |
| `url:` | `url:github.com` | Links to domain |

## Response Fields

When querying, always request:
```
tweet.fields=created_at,public_metrics,author_id,conversation_id,entities
expansions=author_id
user.fields=username,name,public_metrics
```

## Cost (Pay-Per-Use)

- Post read: $0.005/tweet
- User lookup: $0.010/lookup
- Post write: $0.010/action

## Rate Limits

- 350ms delay between requests (built-in)
- 429 response = wait for reset header

## xAI API

### Endpoints
- Chat: `https://api.x.ai/v1/chat/completions`
- Responses: `https://api.x.ai/v1/responses`
- Files: `https://api.x.ai/v1/files`

### Models
- `grok-3` - Most capable
- `grok-3-mini` - Default, fast
- `grok-2` - Legacy
- `grok-2-vision` - Image analysis
