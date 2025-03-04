import { z } from "zod";

/**
 * Base schema for profile validation with detailed error messages
 * @description Contains the common validation rules for both creation and updates
 */
export const profileBaseSchema = z.object({
  name: z
    .string()
    .min(3, { message: "Name must be at least 3 characters long" })
    .max(50, { message: "Name cannot exceed 50 characters" })
    .regex(/^[a-zA-Z0-9\s.]+$/, {
      message: "Name can only contain letters, numbers, spaces and dots",
    }),
  // Don't put here because we need to allow people to import their onchain names
  // .regex(/^[a-zA-Z0-9\s]+$/, {
  //   message: "Name can only contain letters, numbers and spaces",
  // }),
  username: z
    .string()
    .min(3, { message: "Username must be at least 3 characters long" })
    .max(50, { message: "Username cannot exceed 50 characters" })
    .regex(/^[a-zA-Z0-9-]+$/, {
      message: "Username can only contain letters, numbers and dashes",
    }),
  description: z.preprocess(
    // Convert empty string to null before validation
    (val) => (val === "" ? null : val),
    z
      .string()
      .max(500, { message: "Description cannot exceed 500 characters" })
      .nullable()
      .optional(),
  ),
  avatar: z.preprocess(
    // Convert empty string to null before validation
    (val) => (val === "" ? null : val),
    z
      .string()
      .url({ message: "Avatar must be a valid URL" })
      .nullable()
      .optional(),
  ),
});

// For creation - name and username required
export const profileCreationSchema = profileBaseSchema;

// For updates - all fields optional but maintaining validation rules
export const profileUpdateSchema = profileBaseSchema.partial();

// Types
export type ProfileSchemaType = z.infer<typeof profileBaseSchema>;
export type ProfileCreationType = z.infer<typeof profileCreationSchema>;
export type ProfileUpdateType = z.infer<typeof profileUpdateSchema>;
