CREATE TABLE "email_verification_codes" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_verification_codes" ADD CONSTRAINT "email_verification_codes_user_id_users_UniqueID_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;