CREATE TABLE `food_search_queries` (
	`query` text PRIMARY KEY NOT NULL,
	`result_count` integer NOT NULL,
	`fetched_at` integer NOT NULL
);
