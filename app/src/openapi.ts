export const spec = {
  openapi: "3.1.0",
  info: { title: "AnimeUnwatched API", version: "1.0.0", description: "Neural anime social platform API" },
  servers: [{ url: "/api/v1" }],
  tags: [
    { name: "auth" }, { name: "anime" }, { name: "users" }, { name: "lists" },
    { name: "posts" }, { name: "clubs" }, { name: "threads" }, { name: "reviews" },
    { name: "blogs" }, { name: "notifications" }, { name: "search" }
  ],
  paths: {
    "/health": { get: { summary: "Health check", responses: { "200": { description: "OK" } } } },
    "/auth/register": { post: { tags:["auth"], summary:"Register", requestBody: { content: { "application/json": { schema: { type:"object", properties: { email:{type:"string"}, username:{type:"string"}, displayName:{type:"string"}, password:{type:"string"} }, required:["email","username","displayName","password"] } } } }, responses: { "201": { description: "User + accessToken" } } } },
    "/auth/login": { post: { tags:["auth"], summary:"Login", responses: { "200": { description: "User + accessToken" } } } },
    "/auth/refresh": { post: { tags:["auth"], summary:"Refresh token", responses: { "200": { description: "New accessToken" } } } },
    "/auth/logout": { post: { tags:["auth"], summary:"Logout", security:[{"bearerAuth":[]}], responses: { "204": { description: "OK" } } } },
    "/auth/me": { get: { tags:["auth"], summary:"Get current user", security:[{"bearerAuth":[]}], responses: { "200": { description: "User object" } } } },
    "/anime": { get: { tags:["anime"], summary:"Browse anime", parameters:[{name:"q",in:"query"},{name:"year",in:"query"},{name:"season",in:"query"},{name:"page",in:"query"}], responses: { "200": { description: "Paginated anime list" } } } },
    "/anime/{malId}": { get: { tags:["anime"], summary:"Get anime by MAL ID", parameters:[{name:"malId",in:"path",required:true}], responses: { "200": { description: "Anime + listEntry" } } } },
    "/posts/discover": { get: { tags:["posts"], summary:"Discover feed", responses: { "200": { description: "Cursor-paginated posts" } } } },
    "/posts/feed": { get: { tags:["posts"], summary:"Following feed", security:[{"bearerAuth":[]}], responses: { "200": { description: "Cursor-paginated posts from followed users" } } } },
    "/posts": { post: { tags:["posts"], summary:"Create post", security:[{"bearerAuth":[]}], responses: { "201": { description: "New post" } } } },
    "/clubs": { get: { tags:["clubs"], summary:"List clubs", responses: { "200": { description: "Paginated clubs" } } }, post: { tags:["clubs"], summary:"Create club", security:[{"bearerAuth":[]}], responses: { "201": { description: "New club" } } } },
    "/search": { get: { tags:["search"], summary:"Full-text search", parameters:[{name:"q",in:"query",required:true},{name:"type",in:"query",schema:{enum:["anime","posts","users","blogs"]}}], responses: { "200": { description: "Search results" } } } }
  },
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } }
}
